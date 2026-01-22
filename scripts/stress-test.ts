/**
 * ЭКСТРЕМАЛЬНЫЙ СТРЕСС-ТЕСТ
 * 
 * Проверка системы под максимальной нагрузкой:
 * - 5000+ ботов
 * - Параллельные ставки
 * - Проверка целостности данных
 * - Мониторинг производительности
 * 
 * Использование:
 *   npx tsx scripts/stress-test.ts
 *   npx tsx scripts/stress-test.ts --bots=10000 --rps=500
 */

import mongoose, { Types } from 'mongoose';
import { config } from '../src/config';
import { User, Auction, Bid, AuctionStatus, BidStatus, Transaction, TransactionType } from '../src/models';
import { userService, auctionService, bidService, redisService } from '../src/services';
import { logger } from '../src/utils/logger';

// === КОНФИГУРАЦИЯ ===
interface StressConfig {
  totalBots: number;
  targetRPS: number;        // целевые ставки в секунду
  durationSec: number;      // длительность теста
  rampUpSec: number;        // время разгона
  initialBalance: number;
}

const DEFAULT_CONFIG: StressConfig = {
  totalBots: 5000,
  targetRPS: 200,
  durationSec: 120,
  rampUpSec: 30,
  initialBalance: 50000,
};

// === МЕТРИКИ ===
interface Metrics {
  totalAttempts: number;
  successCount: number;
  failCount: number;
  latencies: number[];
  concurrentMax: number;
  errorsMap: Map<string, number>;
  startTime: number;
}

function createMetrics(): Metrics {
  return {
    totalAttempts: 0,
    successCount: 0,
    failCount: 0,
    latencies: [],
    concurrentMax: 0,
    errorsMap: new Map(),
    startTime: Date.now(),
  };
}

// === СТРЕСС ТЕСТЕР ===
class StressTester {
  private config: StressConfig;
  private bots: { id: Types.ObjectId; username: string }[] = [];
  private auctionId!: Types.ObjectId;
  private metrics = createMetrics();
  private running = 0;
  private isActive = false;
  private bidQueue: Promise<void>[] = [];

  constructor(config: StressConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    console.log('\n🚀 ИНИЦИАЛИЗАЦИЯ СТРЕСС-ТЕСТА\n');

    // Подключаемся к БД с большим пулом
    const poolSize = Math.min(200, Math.ceil(this.config.totalBots / 25));
    console.log(`MongoDB pool size: ${poolSize}`);
    
    await mongoose.connect(config.mongodb.uri, {
      maxPoolSize: poolSize,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });

    // Redis
    await redisService.connect();
    if (redisService.connected) {
      console.log('✓ Redis подключён');
    } else {
      console.log('⚠ Redis недоступен, работаем без кэша');
    }

    // Очищаем старые данные
    console.log('Очистка предыдущих данных...');
    await Promise.all([
      User.deleteMany({ username: /^stress_/ }),
      Auction.deleteMany({ title: /^STRESS/ }),
    ]);

    // Создаём аукцион
    await this.createAuction();

    // Создаём ботов параллельно
    await this.createBots();

    console.log('\n✓ Инициализация завершена\n');
  }

  private async createAuction(): Promise<void> {
    let admin = await User.findOne({ username: 'stress_admin' });
    if (!admin) {
      admin = await userService.createUser('stress_admin', 0);
    }

    // Много товаров для большого количества ботов
    const totalItems = Math.min(Math.ceil(this.config.totalBots / 2), 2500);
    const perRound = Math.ceil(totalItems / 5);

    const auction = await auctionService.createAuction({
      title: `STRESS TEST ${new Date().toISOString()}`,
      description: `Стресс-тест: ${this.config.totalBots} ботов, ${this.config.targetRPS} RPS`,
      totalItems,
      startingPrice: 100,
      minBidIncrement: 5,
      roundsConfig: [
        { itemsToDistribute: perRound, durationMs: 30000 },
        { itemsToDistribute: perRound, durationMs: 30000 },
        { itemsToDistribute: perRound, durationMs: 30000 },
        { itemsToDistribute: perRound, durationMs: 30000 },
        { itemsToDistribute: totalItems - perRound * 4, durationMs: 60000 },
      ],
      startTime: new Date(Date.now() + 3000),
      createdBy: admin._id as Types.ObjectId,
    });

    this.auctionId = auction._id as Types.ObjectId;
    console.log(`✓ Аукцион создан: ${totalItems} товаров, 5 раундов`);
  }

  private async createBots(): Promise<void> {
    const total = this.config.totalBots;
    const batchSize = 500;
    const timestamp = Date.now();

    console.log(`Создание ${total} ботов...`);

    for (let i = 0; i < total; i += batchSize) {
      const batch = [];
      const end = Math.min(i + batchSize, total);

      for (let j = i; j < end; j++) {
        batch.push({
          username: `stress_${timestamp}_${j}`,
          balance: this.config.initialBalance,
          lockedBalance: 0,
        });
      }

      const inserted = await User.insertMany(batch, { ordered: false });

      // Транзакции депозита
      const txs = inserted.map(u => ({
        userId: u._id,
        type: TransactionType.DEPOSIT,
        amount: this.config.initialBalance,
        balanceBefore: 0,
        balanceAfter: this.config.initialBalance,
        lockedBefore: 0,
        lockedAfter: 0,
        description: 'Stress test deposit',
      }));
      await Transaction.insertMany(txs, { ordered: false });

      for (const u of inserted) {
        this.bots.push({ id: u._id as Types.ObjectId, username: u.username });
      }

      const pct = Math.round(((i + batch.length) / total) * 100);
      process.stdout.write(`\r  Создано: ${this.bots.length}/${total} (${pct}%)`);
    }

    console.log('\n✓ Боты созданы');
  }

  async run(): Promise<void> {
    console.log('\n' + '═'.repeat(50));
    console.log('          ЗАПУСК СТРЕСС-ТЕСТА');
    console.log('═'.repeat(50));
    console.log(`  Ботов: ${this.config.totalBots}`);
    console.log(`  Целевой RPS: ${this.config.targetRPS}`);
    console.log(`  Длительность: ${this.config.durationSec}с`);
    console.log(`  Разгон: ${this.config.rampUpSec}с`);
    console.log('═'.repeat(50) + '\n');

    // Запуск аукциона
    const auction = await Auction.findById(this.auctionId);
    if (auction?.status === AuctionStatus.PENDING) {
      const wait = auction.startTime.getTime() - Date.now();
      if (wait > 0) {
        console.log(`Ожидание старта: ${Math.ceil(wait / 1000)}с...`);
        await new Promise(r => setTimeout(r, wait + 500));
      }
      await auctionService.startAuction(this.auctionId);
      console.log('✓ Аукцион запущен\n');
    }

    this.metrics = createMetrics();
    this.isActive = true;

    // Мониторинг каждые 3 секунды
    const monitorInterval = setInterval(() => this.printStatus(), 3000);

    // Запуск генератора нагрузки
    await this.generateLoad();

    clearInterval(monitorInterval);
    this.isActive = false;

    // Ждём завершения всех ставок
    console.log('\nОжидание завершения ставок...');
    await Promise.all(this.bidQueue);

    console.log('✓ Тест завершён\n');
  }

  private async generateLoad(): Promise<void> {
    const endTime = Date.now() + this.config.durationSec * 1000;
    const rampEnd = Date.now() + this.config.rampUpSec * 1000;

    while (Date.now() < endTime && this.isActive) {
      // Рассчитываем текущий RPS с учётом разгона
      let currentRPS = this.config.targetRPS;
      if (Date.now() < rampEnd) {
        const progress = (Date.now() - this.metrics.startTime) / (this.config.rampUpSec * 1000);
        currentRPS = Math.ceil(this.config.targetRPS * progress);
      }

      // Сколько ставок запустить за эту итерацию (100мс)
      const bidsToMake = Math.ceil(currentRPS / 10);

      for (let i = 0; i < bidsToMake && this.isActive; i++) {
        const bot = this.bots[Math.floor(Math.random() * this.bots.length)];
        const promise = this.makeBid(bot);
        this.bidQueue.push(promise);

        // Очищаем завершённые промисы
        if (this.bidQueue.length > 1000) {
          this.bidQueue = this.bidQueue.filter(p => p !== undefined);
        }
      }

      await new Promise(r => setTimeout(r, 100));

      // Проверяем статус аукциона
      if (this.metrics.totalAttempts % 100 === 0) {
        const auctionCheck = await Auction.findById(this.auctionId).lean();
        if (auctionCheck?.status !== AuctionStatus.ACTIVE) {
          console.log('\n⚠ Аукцион завершился');
          this.isActive = false;
          break;
        }
      }
    }
  }

  private async makeBid(bot: { id: Types.ObjectId; username: string }): Promise<void> {
    const start = performance.now();
    this.running++;
    this.metrics.totalAttempts++;

    if (this.running > this.metrics.concurrentMax) {
      this.metrics.concurrentMax = this.running;
    }

    try {
      // Получаем минимальную ставку
      const existingBid = await bidService.getUserBid(this.auctionId, bot.id);
      const auction = await Auction.findById(this.auctionId).lean();
      if (!auction) return;

      const minBid = existingBid
        ? existingBid.amount + auction.minBidIncrement
        : auction.startingPrice;

      // Случайная ставка
      const amount = minBid + Math.floor(Math.random() * 30);

      await bidService.placeBid(this.auctionId, bot.id, amount);

      const latency = performance.now() - start;
      this.metrics.successCount++;
      this.metrics.latencies.push(latency);

      // Держим только последние 1000 для экономии памяти
      if (this.metrics.latencies.length > 1000) {
        this.metrics.latencies = this.metrics.latencies.slice(-1000);
      }
    } catch (err: any) {
      this.metrics.failCount++;
      const msg = err.message?.slice(0, 50) || 'Unknown';

      // Учитываем типы ошибок
      if (!msg.includes('Недостаточно') &&
          !msg.includes('завершён') &&
          !msg.includes('ниже текущей')) {
        const count = this.metrics.errorsMap.get(msg) || 0;
        this.metrics.errorsMap.set(msg, count + 1);
      }
    } finally {
      this.running--;
    }
  }

  private printStatus(): void {
    const elapsed = (Date.now() - this.metrics.startTime) / 1000;
    const rps = Math.round(this.metrics.successCount / elapsed);
    const avgLatency = this.metrics.latencies.length > 0
      ? Math.round(this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length)
      : 0;
    const p99 = this.getPercentile(99);
    const successRate = this.metrics.totalAttempts > 0
      ? ((this.metrics.successCount / this.metrics.totalAttempts) * 100).toFixed(1)
      : '0';

    console.log(
      `[${elapsed.toFixed(0)}s] ` +
      `OK: ${this.metrics.successCount} | ` +
      `FAIL: ${this.metrics.failCount} | ` +
      `RPS: ${rps} | ` +
      `Avg: ${avgLatency}ms | ` +
      `P99: ${p99}ms | ` +
      `Concurrent: ${this.running} | ` +
      `Success: ${successRate}%`
    );
  }

  private getPercentile(p: number): number {
    if (this.metrics.latencies.length === 0) return 0;
    const sorted = [...this.metrics.latencies].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return Math.round(sorted[idx]);
  }

  async verify(): Promise<boolean> {
    console.log('\n' + '═'.repeat(50));
    console.log('          ВЕРИФИКАЦИЯ ДАННЫХ');
    console.log('═'.repeat(50) + '\n');

    // Статистика ставок
    const [totalBids, wonBids, activeBids] = await Promise.all([
      Bid.countDocuments({ auctionId: this.auctionId }),
      Bid.countDocuments({ auctionId: this.auctionId, status: BidStatus.WON }),
      Bid.countDocuments({
        auctionId: this.auctionId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
      }),
    ]);

    console.log(`Всего ставок в БД: ${totalBids}`);
    console.log(`Выиграли: ${wonBids}`);
    console.log(`Активных: ${activeBids}`);

    // Проверяем выборку балансов
    const sampleSize = Math.min(200, this.bots.length);
    const sampleBots = this.bots
      .sort(() => Math.random() - 0.5)
      .slice(0, sampleSize);

    let balanceErrors = 0;

    for (const bot of sampleBots) {
      const user = await User.findById(bot.id).lean();
      if (!user) continue;

      const userBids = await Bid.find({ auctionId: this.auctionId, userId: bot.id }).lean();
      const locked = userBids
        .filter(b => b.status === BidStatus.ACTIVE || b.status === BidStatus.CARRIED_OVER)
        .reduce((sum, b) => sum + b.amount, 0);
      const charged = userBids
        .filter(b => b.status === BidStatus.WON)
        .reduce((sum, b) => sum + b.amount, 0);

      if (user.lockedBalance !== locked) {
        balanceErrors++;
        logger.debug(`${bot.username}: locked=${user.lockedBalance}, expected=${locked}`);
      }

      const expectedBalance = this.config.initialBalance - charged;
      if (user.balance !== expectedBalance) {
        balanceErrors++;
        logger.debug(`${bot.username}: balance=${user.balance}, expected=${expectedBalance}`);
      }
    }

    console.log(`\nПроверено балансов: ${sampleSize}`);
    console.log(`Ошибок: ${balanceErrors}`);

    // Итоговые метрики
    const elapsed = (Date.now() - this.metrics.startTime) / 1000;
    const avgLatency = this.metrics.latencies.length > 0
      ? this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length
      : 0;

    console.log('\n' + '═'.repeat(50));
    console.log('          ИТОГОВЫЕ РЕЗУЛЬТАТЫ');
    console.log('═'.repeat(50));
    console.log(`Ботов: ${this.config.totalBots}`);
    console.log(`Длительность: ${elapsed.toFixed(1)}с`);
    console.log(`Всего попыток: ${this.metrics.totalAttempts}`);
    console.log(`Успешных: ${this.metrics.successCount}`);
    console.log(`Неуспешных: ${this.metrics.failCount}`);
    console.log(`Успех: ${((this.metrics.successCount / Math.max(1, this.metrics.totalAttempts)) * 100).toFixed(1)}%`);
    console.log(`Avg RPS: ${Math.round(this.metrics.successCount / elapsed)}`);
    console.log(`Avg latency: ${avgLatency.toFixed(1)}ms`);
    console.log(`P50 latency: ${this.getPercentile(50)}ms`);
    console.log(`P95 latency: ${this.getPercentile(95)}ms`);
    console.log(`P99 latency: ${this.getPercentile(99)}ms`);
    console.log(`Max concurrent: ${this.metrics.concurrentMax}`);
    console.log('═'.repeat(50) + '\n');

    if (this.metrics.errorsMap.size > 0) {
      console.log('Типы ошибок:');
      for (const [msg, count] of this.metrics.errorsMap) {
        console.log(`  ${msg}: ${count}`);
      }
      console.log('');
    }

    return balanceErrors === 0;
  }

  async cleanup(): Promise<void> {
    await redisService.disconnect();
    await mongoose.disconnect();
  }
}

// === MAIN ===
function parseArgs(): StressConfig {
  const args = process.argv.slice(2);
  const cfg = { ...DEFAULT_CONFIG };

  for (const arg of args) {
    const [key, val] = arg.split('=');
    if (key === '--bots') cfg.totalBots = parseInt(val, 10);
    else if (key === '--rps') cfg.targetRPS = parseInt(val, 10);
    else if (key === '--duration') cfg.durationSec = parseInt(val, 10);
    else if (key === '--ramp') cfg.rampUpSec = parseInt(val, 10);
  }

  return cfg;
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║         🔥 EXTREME STRESS TEST 🔥                ║
║         Auction System Load Testing              ║
╚══════════════════════════════════════════════════╝
  `);

  const config = parseArgs();
  const tester = new StressTester(config);

  try {
    await tester.initialize();
    await tester.run();

    console.log('Ожидание обработки раундов (10с)...');
    await new Promise(r => setTimeout(r, 10000));

    const success = await tester.verify();

    if (success) {
      console.log('✅ ТЕСТ ПРОЙДЕН — все балансы корректны!');
    } else {
      console.log('❌ ТЕСТ НЕ ПРОЙДЕН — обнаружены ошибки');
    }
  } catch (err) {
    console.error('Критическая ошибка:', err);
  } finally {
    await tester.cleanup();
    process.exit(0);
  }
}

main();
