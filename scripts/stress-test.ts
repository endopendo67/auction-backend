/**
 * СТРЕСС-ТЕСТ СИСТЕМЫ АУКЦИОНОВ
 * 
 * - 5000 предметов
 * - 5 раундов по 30 секунд
 * - 6000 ботов
 * - Постоянные ставки и перебивание
 * - Максимум 1 снайп за раунд (50% шанс)
 * 
 * Использование: npx tsx scripts/stress-test.ts
 */

import mongoose, { Types } from 'mongoose';
import { config } from '../src/config';
import { User, Auction, Bid, AuctionStatus, BidStatus } from '../src/models';
import { userService, auctionService, bidService, redisService } from '../src/services';

const CONFIG = {
  totalItems: 5000,
  rounds: 5,
  roundDurationSec: 30,
  totalBots: 6000,
  initialBalance: 100000,
  targetRPS: 300,
};

class StressTester {
  private bots: { id: Types.ObjectId; username: string }[] = [];
  private auctionId!: Types.ObjectId;
  private metrics = {
    bids: 0,
    success: 0,
    errors: 0,
    latencies: [] as number[],
  };
  private isRunning = false;

  async initialize(): Promise<void> {
    console.log('\n🚀 Инициализация стресс-теста\n');

    await mongoose.connect(config.mongodb.uri, {
      maxPoolSize: 200,
      serverSelectionTimeoutMS: 30000,
    });

    await redisService.connect();

    // Очистка старых данных
    console.log('Очистка...');
    await User.deleteMany({ username: /^stress_/ });
    await Auction.deleteMany({ title: /^STRESS/ });

    // Создание аукциона
    await this.createAuction();

    // Создание ботов
    await this.createBots();

    console.log('✓ Готово\n');
  }

  private async createAuction(): Promise<void> {
    let admin = await User.findOne({ username: 'stress_admin' });
    if (!admin) {
      admin = await userService.createUser('stress_admin', 0);
    }

    const itemsPerRound = Math.floor(CONFIG.totalItems / CONFIG.rounds);
    const lastRoundItems = CONFIG.totalItems - itemsPerRound * (CONFIG.rounds - 1);

    const roundsConfig = [];
    for (let i = 0; i < CONFIG.rounds - 1; i++) {
      roundsConfig.push({
        itemsToDistribute: itemsPerRound,
        durationMs: CONFIG.roundDurationSec * 1000,
      });
    }
    roundsConfig.push({
      itemsToDistribute: lastRoundItems,
      durationMs: CONFIG.roundDurationSec * 1000,
    });

    const auction = await auctionService.createAuction({
      title: `STRESS TEST ${Date.now()}`,
      description: `${CONFIG.totalItems} товаров, ${CONFIG.totalBots} ботов, ${CONFIG.rounds} раундов`,
      totalItems: CONFIG.totalItems,
      startingPrice: 100,
      minBidIncrement: 10,
      roundsConfig,
      startTime: new Date(Date.now() + 5000),
      createdBy: admin._id as Types.ObjectId,
    });

    this.auctionId = auction._id as Types.ObjectId;
    console.log(`✓ Аукцион: ${CONFIG.totalItems} товаров, ${CONFIG.rounds} раундов по ${CONFIG.roundDurationSec}с`);
  }

  private async createBots(): Promise<void> {
    console.log(`Создание ${CONFIG.totalBots} ботов...`);
    const batchSize = 1000;

    for (let i = 0; i < CONFIG.totalBots; i += batchSize) {
      const batch = [];
      const end = Math.min(i + batchSize, CONFIG.totalBots);

      for (let j = i; j < end; j++) {
        batch.push({
          username: `stress_${j}`,
          balance: CONFIG.initialBalance,
          lockedBalance: 0,
          isBot: true,
        });
      }

      const inserted = await User.insertMany(batch, { ordered: false });
      this.bots.push(...inserted.map(u => ({ id: u._id as Types.ObjectId, username: u.username })));

      process.stdout.write(`\r  ${this.bots.length}/${CONFIG.totalBots}`);
    }

    console.log('\n✓ Боты созданы');
  }

  async run(): Promise<void> {
    console.log('\n═'.repeat(50));
    console.log('  ЗАПУСК СТРЕСС-ТЕСТА');
    console.log('═'.repeat(50));
    console.log(`  Товаров: ${CONFIG.totalItems}`);
    console.log(`  Раундов: ${CONFIG.rounds} × ${CONFIG.roundDurationSec}с`);
    console.log(`  Ботов: ${CONFIG.totalBots}`);
    console.log(`  Целевой RPS: ${CONFIG.targetRPS}`);
    console.log('═'.repeat(50) + '\n');

    // Запуск
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

    this.isRunning = true;

    // Мониторинг
    const monitor = setInterval(() => this.printStatus(), 3000);

    // Генерация нагрузки
    const promises: Promise<void>[] = [];
    const interval = setInterval(async () => {
      if (!this.isRunning) return;

      // Проверка статуса аукциона
      const auctionCheck = await Auction.findById(this.auctionId).select('status').lean();
      if (auctionCheck?.status !== AuctionStatus.ACTIVE) {
        this.isRunning = false;
        clearInterval(interval);
        return;
      }

      // Генерация ставок
      const bidsPerTick = Math.ceil(CONFIG.targetRPS / 10);
      for (let i = 0; i < bidsPerTick; i++) {
        const bot = this.bots[Math.floor(Math.random() * this.bots.length)];
        promises.push(this.makeBid(bot));
      }
    }, 100);

    // Ждём завершения аукциона или таймаута
    const maxTime = CONFIG.rounds * CONFIG.roundDurationSec * 1000 + 60000;
    await new Promise(r => setTimeout(r, maxTime));
    this.isRunning = false;
    clearInterval(interval);
    clearInterval(monitor);

    console.log('\nОжидание завершения ставок...');
    await Promise.all(promises);

    console.log('✓ Тест завершён\n');
  }

  private async makeBid(bot: { id: Types.ObjectId; username: string }): Promise<void> {
    const start = performance.now();
    this.metrics.bids++;

    try {
      const existingBid = await bidService.getUserBid(this.auctionId, bot.id);
      const auction = await Auction.findById(this.auctionId).select('startingPrice minBidIncrement').lean();
      if (!auction) return;

      const minAmount = existingBid
        ? existingBid.amount + auction.minBidIncrement
        : auction.startingPrice;

      const amount = minAmount + Math.floor(Math.random() * 50);

      await bidService.placeBid(this.auctionId, bot.id, amount);

      const latency = performance.now() - start;
      this.metrics.success++;
      this.metrics.latencies.push(latency);

      if (this.metrics.latencies.length > 1000) {
        this.metrics.latencies = this.metrics.latencies.slice(-1000);
      }
    } catch (err: any) {
      this.metrics.errors++;
    }
  }

  private printStatus(): void {
    const avg = this.metrics.latencies.length > 0
      ? Math.round(this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length)
      : 0;
    
    console.log(
      `Ставки: ${this.metrics.success} | ` +
      `Ошибки: ${this.metrics.errors} | ` +
      `Avg: ${avg}ms`
    );
  }

  async verify(): Promise<void> {
    console.log('\n═'.repeat(50));
    console.log('  ВЕРИФИКАЦИЯ');
    console.log('═'.repeat(50) + '\n');

    const [totalBids, wonBids] = await Promise.all([
      Bid.countDocuments({ auctionId: this.auctionId }),
      Bid.countDocuments({ auctionId: this.auctionId, status: BidStatus.WON }),
    ]);

    console.log(`Всего ставок: ${totalBids}`);
    console.log(`Выиграли: ${wonBids}`);
    console.log(`Success rate: ${((this.metrics.success / this.metrics.bids) * 100).toFixed(1)}%`);
    console.log('═'.repeat(50) + '\n');
  }

  async cleanup(): Promise<void> {
    await redisService.disconnect();
    await mongoose.disconnect();
  }
}

async function main() {
  const tester = new StressTester();

  try {
    await tester.initialize();
    await tester.run();
    await tester.verify();
  } catch (err) {
    console.error('Ошибка:', err);
  } finally {
    await tester.cleanup();
    process.exit(0);
  }
}

main();
