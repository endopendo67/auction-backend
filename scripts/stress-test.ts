/**
 * СТРЕСС-ТЕСТ СИСТЕМЫ АУКЦИОНОВ
 * 
 * МАКСИМАЛЬНАЯ ОПТИМИЗАЦИЯ:
 * - Высокий параллелизм
 * - Connection pooling
 * - Агрессивное перебивание
 * 
 * Использование: npx tsx scripts/stress-test.ts
 */

import mongoose, { Types } from 'mongoose';
import http from 'http';
import { config } from '../src/config';
import { User, Auction, Bid, AuctionStatus, BidStatus } from '../src/models';
import { userService, auctionService, redisService } from '../src/services';

const CONFIG = {
  totalItems: 5000,
  rounds: 5,
  roundDurationSec: 30,
  totalBots: 6000,
  initialBalance: 100000,
  concurrentRequests: 300,   // Высокий параллелизм
  requestDelayMs: 5,         // Минимальная задержка
  apiHost: 'localhost',
  apiPort: 80,
};

// HTTP агент с максимальным connection pooling
const agent = new http.Agent({ 
  keepAlive: true, 
  maxSockets: 500,           // Много соединений
  maxFreeSockets: 100,
  keepAliveMsecs: 5000,
  scheduling: 'fifo',
});

interface Bot {
  id: Types.ObjectId;
  username: string;
  currentBid: number;
}

class StressTester {
  private bots: Bot[] = [];
  private auctionId!: Types.ObjectId;
  private auctionIdStr!: string;
  private metrics = {
    bids: 0,
    success: 0,
    errors: 0,
    latencies: [] as number[],
  };
  private isRunning = false;
  private topBid = 100;
  private minIncrement = 10;

  async initialize(): Promise<void> {
    console.log('\n🚀 СТРЕСС-ТЕСТ (MAX PERFORMANCE)\n');
    console.log(`API: http://${CONFIG.apiHost}:${CONFIG.apiPort}`);
    console.log(`Параллельность: ${CONFIG.concurrentRequests}`);
    
    await mongoose.connect(config.mongodb.uri, {
      maxPoolSize: 200,
      minPoolSize: 50,
      serverSelectionTimeoutMS: 10000,
    });

    await redisService.connect();

    console.log('Очистка...');
    await Promise.all([
      User.deleteMany({ username: /^stress_/ }),
      Auction.deleteMany({ title: /^STRESS/ }),
    ]);

    await this.createAuction();
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
      description: `MAX LOAD TEST`,
      totalItems: CONFIG.totalItems,
      startingPrice: 100,
      minBidIncrement: 10,
      roundsConfig,
      startTime: new Date(Date.now() + 3000), // Быстрый старт
      createdBy: admin._id as Types.ObjectId,
    });

    this.auctionId = auction._id as Types.ObjectId;
    this.auctionIdStr = this.auctionId.toString();
    this.minIncrement = auction.minBidIncrement || 10;
    this.topBid = auction.startingPrice;
    
    console.log(`✓ Аукцион: ${CONFIG.totalItems} товаров, ID: ${this.auctionIdStr}`);
  }

  private async createBots(): Promise<void> {
    console.log(`Создание ${CONFIG.totalBots} ботов...`);
    
    // Создаём большими батчами параллельно
    const batchSize = 2000;
    const batches: Promise<Bot[]>[] = [];

    for (let i = 0; i < CONFIG.totalBots; i += batchSize) {
      const end = Math.min(i + batchSize, CONFIG.totalBots);
      batches.push(this.createBotBatch(i, end));
    }

    const results = await Promise.all(batches);
    this.bots = results.flat();
    
    console.log(`✓ ${this.bots.length} ботов созданы`);
  }

  private async createBotBatch(start: number, end: number): Promise<Bot[]> {
    const batch = [];
    for (let j = start; j < end; j++) {
      batch.push({
        username: `stress_${j}`,
        balance: CONFIG.initialBalance,
        lockedBalance: 0,
        isBot: true,
      });
    }

    const inserted = await User.insertMany(batch, { ordered: false });
    return inserted.map(u => ({ 
      id: u._id as Types.ObjectId, 
      username: u.username,
      currentBid: 0,
    }));
  }

  async run(): Promise<void> {
    console.log('═'.repeat(50));
    console.log(`  СТАРТ: ${CONFIG.concurrentRequests} RPS target`);
    console.log('═'.repeat(50) + '\n');

    const auction = await Auction.findById(this.auctionId);
    if (auction?.status === AuctionStatus.PENDING) {
      const wait = auction.startTime.getTime() - Date.now();
      if (wait > 0) {
        console.log(`Ожидание: ${Math.ceil(wait / 1000)}с...`);
        await new Promise(r => setTimeout(r, wait + 200));
      }
      
      try {
        await this.callApi('POST', `/api/auctions/${this.auctionIdStr}/start`, {});
        console.log('✓ Аукцион запущен\n');
      } catch {
        await auctionService.startAuction(this.auctionId);
      }
    }

    this.isRunning = true;
    const monitor = setInterval(() => this.printStatus(), 2000);

    // Главный цикл — максимальный параллелизм
    while (this.isRunning) {
      const auctionCheck = await Auction.findById(this.auctionId)
        .select('status')
        .lean();
        
      if (auctionCheck?.status !== AuctionStatus.ACTIVE) {
        this.isRunning = false;
        break;
      }

      // Обновляем topBid
      const topBidDoc = await Bid.findOne({ auctionId: this.auctionId })
        .sort({ amount: -1 })
        .select('amount')
        .lean();
      if (topBidDoc) this.topBid = topBidDoc.amount;

      // Запускаем пачку запросов
      const batch: Promise<void>[] = [];
      for (let i = 0; i < CONFIG.concurrentRequests; i++) {
        const bot = this.bots[Math.floor(Math.random() * this.bots.length)];
        batch.push(this.makeBid(bot));
      }

      await Promise.allSettled(batch);
      await new Promise(r => setTimeout(r, CONFIG.requestDelayMs));
    }

    clearInterval(monitor);
    console.log('\n✓ Завершено\n');
  }

  private async makeBid(bot: Bot): Promise<void> {
    const start = performance.now();
    this.metrics.bids++;

    try {
      // Агрессивное перебивание: +10-50 от текущего топа
      const jump = this.minIncrement * (1 + Math.floor(Math.random() * 5));
      const amount = this.topBid + jump;

      const response = await this.callApi('POST', `/api/auctions/${this.auctionIdStr}/bid`, {
        userId: bot.id.toString(),
        amount,
      });

      if (response.success) {
        if (response.data?.bid?.amount > this.topBid) {
          this.topBid = response.data.bid.amount;
        }
        
        const latency = performance.now() - start;
        this.metrics.success++;
        this.metrics.latencies.push(latency);

        if (this.metrics.latencies.length > 300) {
          this.metrics.latencies = this.metrics.latencies.slice(-300);
        }
      } else {
        this.metrics.errors++;
      }
    } catch {
      this.metrics.errors++;
    }
  }

  private callApi(method: string, path: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);

      const req = http.request({
        hostname: CONFIG.apiHost,
        port: CONFIG.apiPort,
        path,
        method,
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ success: res.statusCode === 200 || res.statusCode === 201 });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  private printStatus(): void {
    const avg = this.metrics.latencies.length > 0
      ? Math.round(this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length)
      : 0;

    const p99 = this.metrics.latencies.length > 10
      ? Math.round(this.metrics.latencies.sort((a, b) => b - a)[Math.floor(this.metrics.latencies.length * 0.01)])
      : 0;

    const total = this.metrics.success + this.metrics.errors;
    const rate = total > 0 ? ((this.metrics.success / total) * 100).toFixed(0) : '0';

    console.log(
      `✓${this.metrics.success} ✗${this.metrics.errors} | ` +
      `Avg:${avg}ms P99:${p99}ms | ` +
      `Top:${this.topBid}⭐ | ${rate}%`
    );
  }

  async verify(): Promise<void> {
    console.log('═'.repeat(50));
    console.log('  РЕЗУЛЬТАТЫ');
    console.log('═'.repeat(50));

    const [totalBids, wonBids] = await Promise.all([
      Bid.countDocuments({ auctionId: this.auctionId }),
      Bid.countDocuments({ auctionId: this.auctionId, status: BidStatus.WON }),
    ]);

    const total = this.metrics.success + this.metrics.errors;
    const avg = this.metrics.latencies.length > 0
      ? Math.round(this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length)
      : 0;
    
    console.log(`\nСтавок в БД: ${totalBids}`);
    console.log(`Победителей: ${wonBids}`);
    console.log(`API запросов: ${total}`);
    console.log(`Успешных: ${this.metrics.success} (${((this.metrics.success / total) * 100).toFixed(1)}%)`);
    console.log(`Средняя задержка: ${avg}ms`);
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
