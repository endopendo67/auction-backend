/**
 * Нагрузочное тестирование аукциона.
 * 
 * Использование:
 *   npx tsx scripts/load-test.ts --bots=50
 *   npx tsx scripts/load-test.ts --bots=1000 --duration=120000 --intensity=0.3
 */

import mongoose, { Types } from 'mongoose';
import { config } from '../src/config';
import { User, Auction, Bid, AuctionStatus, BidStatus, Transaction, TransactionType } from '../src/models';
import { userService, auctionService, bidService } from '../src/services';
import { logger } from '../src/utils/logger';

interface TestConfig {
  numBots: number;
  auctionId?: string;
  durationMs: number;
  bidsPerSecond: number;
  batchSize: number;
}

interface TestStats {
  totalBids: number;
  successfulBids: number;
  failedBids: number;
  responseTimeSum: number;
  responseTimeCount: number;
  maxResponseTime: number;
  minResponseTime: number;
  concurrentPeaks: number;
  antiSnipeExtensions: number;
}

function parseArgs(): TestConfig {
  const args = process.argv.slice(2);
  const cfg: TestConfig = {
    numBots: 20,
    durationMs: 60000,
    bidsPerSecond: 0.5,
    batchSize: 100, // для создания юзеров батчами
  };

  for (const arg of args) {
    const [key, val] = arg.split('=');
    if (key === '--bots') cfg.numBots = parseInt(val, 10);
    else if (key === '--auction') cfg.auctionId = val;
    else if (key === '--duration') cfg.durationMs = parseInt(val, 10);
    else if (key === '--intensity') cfg.bidsPerSecond = parseFloat(val);
    else if (key === '--batch') cfg.batchSize = parseInt(val, 10);
  }

  // Автоматически снижаем интенсивность при большом количестве ботов
  if (cfg.numBots > 200 && cfg.bidsPerSecond > 0.3) {
    cfg.bidsPerSecond = 0.3;
    logger.info(`Интенсивность снижена до ${cfg.bidsPerSecond} для ${cfg.numBots} ботов`);
  }

  return cfg;
}

interface BotUser {
  id: Types.ObjectId;
  username: string;
  currentBid: number;
  isActive: boolean;
}

class LoadTester {
  private cfg: TestConfig;
  private bots: BotUser[] = [];
  private auctionId!: Types.ObjectId;
  private stats: TestStats = {
    totalBids: 0,
    successfulBids: 0,
    failedBids: 0,
    responseTimeSum: 0,
    responseTimeCount: 0,
    maxResponseTime: 0,
    minResponseTime: Infinity,
    concurrentPeaks: 0,
    antiSnipeExtensions: 0,
  };
  private runningBids = 0;
  private isRunning = false;
  private startBalance = 100000;

  constructor(cfg: TestConfig) {
    this.cfg = cfg;
  }

  async init(): Promise<void> {
    logger.info('Подключение к базе...');
    await mongoose.connect(config.mongodb.uri, {
      maxPoolSize: Math.min(100, Math.ceil(this.cfg.numBots / 10)),
    });

    // Чистим предыдущие тесты
    logger.info('Очистка данных предыдущих тестов...');
    await User.deleteMany({ username: /^loadtest_/ });
    await Auction.deleteMany({ title: /^Нагрузочный тест/ });

    if (this.cfg.auctionId) {
      const auction = await Auction.findById(this.cfg.auctionId);
      if (!auction) throw new Error(`Аукцион ${this.cfg.auctionId} не найден`);
      this.auctionId = auction._id as Types.ObjectId;
      logger.info(`Используем аукцион: ${this.auctionId}`);
    } else {
      await this.createTestAuction();
    }

    await this.createBotsBatch();
  }

  private async createTestAuction(): Promise<void> {
    let admin = await User.findOne({ username: 'loadtest_admin' });
    if (!admin) {
      admin = await userService.createUser('loadtest_admin', 0);
    }

    // Больше товаров для большего количества ботов
    const totalItems = Math.min(this.cfg.numBots, 500);
    const itemsPerRound = Math.ceil(totalItems / 3);

    const auction = await auctionService.createAuction({
      title: `Нагрузочный тест ${Date.now()}`,
      description: `Тест на ${this.cfg.numBots} ботов`,
      totalItems,
      startingPrice: 100,
      minBidIncrement: 10,
      roundsConfig: [
        { itemsToDistribute: itemsPerRound, durationMs: 45000 },
        { itemsToDistribute: itemsPerRound, durationMs: 45000 },
        { itemsToDistribute: totalItems - itemsPerRound * 2, durationMs: 60000 },
      ],
      startTime: new Date(Date.now() + 5000),
      createdBy: admin._id as Types.ObjectId,
    });

    this.auctionId = auction._id as Types.ObjectId;
    logger.info(`Создан тестовый аукцион: ${this.auctionId} (${totalItems} товаров)`);
  }

  /**
   * Создание ботов батчами для скорости
   */
  private async createBotsBatch(): Promise<void> {
    const total = this.cfg.numBots;
    const batchSize = this.cfg.batchSize;
    
    logger.info(`Создаём ${total} ботов (батчами по ${batchSize})...`);
    
    const timestamp = Date.now();
    let created = 0;

    for (let batch = 0; batch * batchSize < total; batch++) {
      const batchStart = batch * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, total);
      
      const usersToCreate = [];
      for (let i = batchStart; i < batchEnd; i++) {
        usersToCreate.push({
          username: `loadtest_${timestamp}_${i}`,
          balance: this.startBalance,
          lockedBalance: 0,
        });
      }

      // Bulk insert
      const insertedUsers = await User.insertMany(usersToCreate, { ordered: false });

      // Создаём записи транзакций (депозит)
      const transactions = insertedUsers.map(user => ({
        userId: user._id,
        type: TransactionType.DEPOSIT,
        amount: this.startBalance,
        balanceBefore: 0,
        balanceAfter: this.startBalance,
        lockedBefore: 0,
        lockedAfter: 0,
        description: 'Начальный депозит для теста',
      }));
      await Transaction.insertMany(transactions, { ordered: false });

      for (const user of insertedUsers) {
        this.bots.push({
          id: user._id as Types.ObjectId,
          username: user.username,
          currentBid: 0,
          isActive: true,
        });
      }

      created += insertedUsers.length;
      
      // Прогресс
      if (total > 100) {
        const pct = Math.round((created / total) * 100);
        process.stdout.write(`\rСоздано ботов: ${created}/${total} (${pct}%)`);
      }
    }

    if (total > 100) console.log('');
    logger.info(`Готово: ${this.bots.length} ботов`);
  }

  async runTest(): Promise<void> {
    console.log('\n=== ЗАПУСК ТЕСТА ===');
    console.log(`Ботов: ${this.cfg.numBots}`);
    console.log(`Длительность: ${this.cfg.durationMs / 1000}с`);
    console.log(`Интенсивность: ${this.cfg.bidsPerSecond} ставок/сек на бота`);
    console.log(`Ожидаемый RPS: ~${Math.round(this.cfg.numBots * this.cfg.bidsPerSecond)}`);
    console.log('');

    // Ждём старта аукциона
    const auction = await Auction.findById(this.auctionId);
    if (auction?.status === AuctionStatus.PENDING) {
      const waitTime = auction.startTime.getTime() - Date.now();
      if (waitTime > 0) {
        logger.info(`Ждём ${Math.ceil(waitTime / 1000)}с до старта аукциона...`);
        await new Promise(r => setTimeout(r, waitTime + 500));
      }
      await auctionService.startAuction(this.auctionId);
      logger.info('Аукцион запущен');
    } else if (auction?.status === AuctionStatus.ACTIVE) {
      logger.info('Аукцион уже активен');
    }

    this.isRunning = true;
    const endTime = Date.now() + this.cfg.durationMs;

    // Запускаем ботов группами чтобы не перегрузить систему
    const groupSize = Math.ceil(this.bots.length / 20);
    const botPromises: Promise<void>[] = [];

    for (let i = 0; i < this.bots.length; i++) {
      const delay = Math.floor(i / groupSize) * 100 + Math.random() * 50;
      botPromises.push(this.runBot(this.bots[i], delay, endTime));
    }

    // Логируем статус каждые 5 секунд
    const statusInterval = setInterval(() => {
      const rps = this.stats.responseTimeCount > 0 
        ? Math.round(this.stats.successfulBids / ((Date.now() - (endTime - this.cfg.durationMs)) / 1000))
        : 0;
      const avgMs = this.stats.responseTimeCount > 0
        ? Math.round(this.stats.responseTimeSum / this.stats.responseTimeCount)
        : 0;
      console.log(`[${new Date().toLocaleTimeString()}] OK: ${this.stats.successfulBids} | FAIL: ${this.stats.failedBids} | RPS: ${rps} | Avg: ${avgMs}ms | Concurrent: ${this.runningBids}`);
    }, 5000);

    await Promise.all(botPromises);
    clearInterval(statusInterval);

    this.isRunning = false;
    logger.info('Тест завершён');
  }

  private async runBot(bot: BotUser, startDelay: number, endTime: number): Promise<void> {
    const bidInterval = 1000 / this.cfg.bidsPerSecond;

    // Задержка старта
    await new Promise(r => setTimeout(r, startDelay));

    while (Date.now() < endTime && this.isRunning) {
      try {
        await this.makeBotBid(bot);
      } catch { /* ignore */ }

      // Случайный интервал между ставками
      const jitter = Math.random() * bidInterval * 0.5;
      await new Promise(r => setTimeout(r, bidInterval + jitter));
    }
  }

  private async makeBotBid(bot: BotUser): Promise<void> {
    // Быстрая проверка статуса аукциона (кэшируем на короткое время)
    const auction = await Auction.findById(this.auctionId).lean();
    if (!auction || auction.status !== AuctionStatus.ACTIVE) return;

    const existingBid = await bidService.getUserBid(this.auctionId, bot.id);
    const minBid = existingBid
      ? existingBid.amount + auction.minBidIncrement
      : auction.startingPrice;

    // Случайная ставка
    const bidAmount = minBid + Math.floor(Math.random() * 50);

    const startTime = performance.now();
    this.runningBids++;
    this.stats.totalBids++;

    if (this.runningBids > this.stats.concurrentPeaks) {
      this.stats.concurrentPeaks = this.runningBids;
    }

    try {
      const result = await bidService.placeBid(this.auctionId, bot.id, bidAmount);

      const responseTime = performance.now() - startTime;
      this.stats.responseTimeSum += responseTime;
      this.stats.responseTimeCount++;
      this.stats.successfulBids++;

      if (result.roundExtended) {
        this.stats.antiSnipeExtensions++;
      }

      bot.currentBid = bidAmount;

      if (responseTime > this.stats.maxResponseTime) this.stats.maxResponseTime = responseTime;
      if (responseTime < this.stats.minResponseTime) this.stats.minResponseTime = responseTime;
    } catch (err: any) {
      this.stats.failedBids++;
      // Логируем только неожиданные ошибки
      const msg = err.message || '';
      if (!msg.includes('Недостаточно') &&
          !msg.includes('завершён') &&
          !msg.includes('не актив') &&
          !msg.includes('ниже текущей')) {
        logger.debug(`Бот ${bot.username}: ${msg}`);
      }
    } finally {
      this.runningBids--;
    }
  }

  async verify(): Promise<boolean> {
    logger.info('Проверка целостности данных...');

    const bids = await Bid.find({ auctionId: this.auctionId });
    const winningBids = bids.filter(b => b.status === BidStatus.WON);
    const activeBids = bids.filter(b =>
      b.status === BidStatus.ACTIVE || b.status === BidStatus.CARRIED_OVER
    );

    let balanceErrors = 0;
    let checked = 0;

    // Проверяем выборочно для большого количества ботов
    const botsToCheck = this.bots.length > 100 
      ? this.bots.filter((_, i) => i % Math.ceil(this.bots.length / 100) === 0)
      : this.bots;

    for (const bot of botsToCheck) {
      const user = await User.findById(bot.id);
      if (!user) continue;

      const userBids = bids.filter(b => b.userId.toString() === bot.id.toString());
      const userActiveBids = userBids.filter(b =>
        b.status === BidStatus.ACTIVE || b.status === BidStatus.CARRIED_OVER
      );
      const userWonBids = userBids.filter(b => b.status === BidStatus.WON);

      const expectedLocked = userActiveBids.reduce((sum, b) => sum + b.amount, 0);
      const expectedCharged = userWonBids.reduce((sum, b) => sum + b.amount, 0);

      if (user.lockedBalance !== expectedLocked) {
        logger.error(`${bot.username}: locked=${user.lockedBalance}, expected=${expectedLocked}`);
        balanceErrors++;
      }

      const expectedBalance = this.startBalance - expectedCharged;
      if (user.balance !== expectedBalance) {
        logger.error(`${bot.username}: balance=${user.balance}, expected=${expectedBalance}`);
        balanceErrors++;
      }

      checked++;
    }

    // Считаем среднее время ответа
    const avgResponseTime = this.stats.responseTimeCount > 0
      ? this.stats.responseTimeSum / this.stats.responseTimeCount
      : 0;

    // Результаты
    console.log('\n========== РЕЗУЛЬТАТЫ ТЕСТА ==========');
    console.log(`Ботов: ${this.cfg.numBots}`);
    console.log(`Длительность: ${this.cfg.durationMs / 1000}с`);
    console.log('');
    console.log(`Всего попыток: ${this.stats.totalBids}`);
    console.log(`Успешных: ${this.stats.successfulBids}`);
    console.log(`Неуспешных: ${this.stats.failedBids}`);
    console.log(`Успех: ${((this.stats.successfulBids / Math.max(1, this.stats.totalBids)) * 100).toFixed(1)}%`);
    console.log('');
    console.log(`Avg response: ${avgResponseTime.toFixed(1)}ms`);
    console.log(`Min response: ${this.stats.minResponseTime === Infinity ? 0 : this.stats.minResponseTime.toFixed(1)}ms`);
    console.log(`Max response: ${this.stats.maxResponseTime.toFixed(1)}ms`);
    console.log(`Peak concurrent: ${this.stats.concurrentPeaks}`);
    console.log(`RPS: ${Math.round(this.stats.successfulBids / (this.cfg.durationMs / 1000))}`);
    console.log('');
    console.log(`Anti-snipe продлений: ${this.stats.antiSnipeExtensions}`);
    console.log(`Победителей: ${winningBids.length}`);
    console.log(`Активных ставок: ${activeBids.length}`);
    console.log(`Проверено балансов: ${checked}`);
    console.log(`Ошибок баланса: ${balanceErrors}`);
    console.log('========================================\n');

    return balanceErrors === 0;
  }

  async cleanup(): Promise<void> {
    // Опционально: очистка тестовых данных
    // await User.deleteMany({ username: /^loadtest_/ });
    await mongoose.disconnect();
  }
}

async function main() {
  const testConfig = parseArgs();
  const tester = new LoadTester(testConfig);

  console.log(`
╔═══════════════════════════════════════╗
║     AUCTION LOAD TEST                 ║
╚═══════════════════════════════════════╝
`);

  try {
    await tester.init();
    await tester.runTest();

    logger.info('Ждём обработки раундов...');
    await new Promise(r => setTimeout(r, 5000));

    const success = await tester.verify();

    if (success) {
      console.log('✅ Тест ПРОЙДЕН — балансы сходятся');
    } else {
      console.log('❌ Тест НЕ ПРОЙДЕН — обнаружены ошибки балансов');
    }
  } catch (err) {
    logger.error('Ошибка теста:', err);
  } finally {
    await tester.cleanup();
    process.exit(0);
  }
}

main();
