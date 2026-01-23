/**
 * СТРЕСС-ТЕСТ СИСТЕМЫ АУКЦИОНОВ
 * 
 * ОПТИМИЗИРОВАННАЯ ВЕРСИЯ:
 * - Умное перебивание с актуальными данными
 * - Контролируемый параллелизм
 * - Агрессивное повышение ставок
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
  // Оптимизированные параметры
  concurrentRequests: 50,
  requestDelayMs: 20,
  // Локальный адрес для работы внутри Docker
  apiHost: 'localhost',
  apiPort: 80,
};

// HTTP агент с connection pooling (локально без HTTPS)
const agent = new http.Agent({ 
  keepAlive: true, 
  maxSockets: 100,
  keepAliveMsecs: 10000,
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
  private activeRequests = 0;

  async initialize(): Promise<void> {
    console.log('\n🚀 Инициализация стресс-теста\n');
    console.log(`API: http://${CONFIG.apiHost}:${CONFIG.apiPort}`);
    console.log(`Параллельных запросов: ${CONFIG.concurrentRequests}`);
    
    await mongoose.connect(config.mongodb.uri, {
      maxPoolSize: 100,
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
      description: `${CONFIG.totalItems} товаров, ${CONFIG.totalBots} ботов`,
      totalItems: CONFIG.totalItems,
      startingPrice: 100,
      minBidIncrement: 10,
      roundsConfig,
      startTime: new Date(Date.now() + 5000),
      createdBy: admin._id as Types.ObjectId,
    });

    this.auctionId = auction._id as Types.ObjectId;
    this.auctionIdStr = this.auctionId.toString();
    this.minIncrement = auction.minBidIncrement || 10;
    this.topBid = auction.startingPrice;
    
    console.log(`✓ Аукцион: ${CONFIG.totalItems} товаров, ${CONFIG.rounds} раундов`);
    console.log(`  ID: ${this.auctionIdStr}`);
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
      this.bots.push(...inserted.map(u => ({ 
        id: u._id as Types.ObjectId, 
        username: u.username,
        currentBid: 0,
      })));

      process.stdout.write(`\r  ${this.bots.length}/${CONFIG.totalBots}`);
    }

    console.log('\n✓ Боты созданы');
  }

  async run(): Promise<void> {
    console.log('\n═'.repeat(50));
    console.log('  СТРЕСС-ТЕСТ (Оптимизированный)');
    console.log('═'.repeat(50));
    console.log(`  Товаров: ${CONFIG.totalItems}`);
    console.log(`  Раундов: ${CONFIG.rounds} × ${CONFIG.roundDurationSec}с`);
    console.log(`  Ботов: ${CONFIG.totalBots}`);
    console.log(`  Параллельность: ${CONFIG.concurrentRequests}`);
    console.log('═'.repeat(50) + '\n');

    // Ждём старта
    const auction = await Auction.findById(this.auctionId);
    if (auction?.status === AuctionStatus.PENDING) {
      const wait = auction.startTime.getTime() - Date.now();
      if (wait > 0) {
        console.log(`Ожидание старта: ${Math.ceil(wait / 1000)}с...`);
        await new Promise(r => setTimeout(r, wait + 500));
      }
      
      try {
        await this.callApi('POST', `/api/auctions/${this.auctionIdStr}/start`, {});
        console.log('✓ Аукцион запущен\n');
      } catch {
        await auctionService.startAuction(this.auctionId);
        console.log('✓ Аукцион запущен напрямую\n');
      }
    }

    this.isRunning = true;

    // Мониторинг
    const monitor = setInterval(() => this.printStatus(), 3000);

    // Основной цикл — контролируемый параллелизм
    while (this.isRunning) {
      // Проверяем статус аукциона
      const auctionCheck = await Auction.findById(this.auctionId).select('status').lean();
      if (auctionCheck?.status !== AuctionStatus.ACTIVE) {
        this.isRunning = false;
        break;
      }

      // Обновляем topBid из базы
      const topBidDoc = await Bid.findOne({ auctionId: this.auctionId })
        .sort({ amount: -1 })
        .select('amount')
        .lean();
      if (topBidDoc) this.topBid = topBidDoc.amount;

      // Запускаем пачку конкурентных запросов
      const batch: Promise<void>[] = [];
      for (let i = 0; i < CONFIG.concurrentRequests && this.isRunning; i++) {
        const bot = this.bots[Math.floor(Math.random() * this.bots.length)];
        batch.push(this.makeBid(bot));
      }

      await Promise.allSettled(batch);
      
      // Небольшая пауза между пачками
      await new Promise(r => setTimeout(r, CONFIG.requestDelayMs));
    }

    clearInterval(monitor);
    console.log('\n✓ Тест завершён\n');
  }

  /**
   * Умная ставка — ВСЕГДА перебивает топ
   */
  private async makeBid(bot: Bot): Promise<void> {
    const start = performance.now();
    this.metrics.bids++;

    try {
      // ВСЕГДА перебиваем топ на случайную сумму
      const jumpMultiplier = 1 + Math.floor(Math.random() * 5); // 1-5x минимального шага
      const amount = this.topBid + (this.minIncrement * jumpMultiplier);

      const response = await this.callApi('POST', `/api/auctions/${this.auctionIdStr}/bid`, {
        userId: bot.id.toString(),
        amount,
      });

      if (response.success) {
        // Обновляем topBid из ответа если есть
        if (response.data?.bid?.amount) {
          const newAmount = response.data.bid.amount;
          if (newAmount > this.topBid) {
            this.topBid = newAmount;
          }
        }
        
        bot.currentBid = amount;
        
        const latency = performance.now() - start;
        this.metrics.success++;
        this.metrics.latencies.push(latency);

        // Держим только последние 500 для памяти
        if (this.metrics.latencies.length > 500) {
          this.metrics.latencies = this.metrics.latencies.slice(-500);
        }
      } else {
        this.metrics.errors++;
      }
    } catch {
      this.metrics.errors++;
    }
  }

  /**
   * HTTPS API вызов
   */
  private callApi(method: string, path: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);

      const options: http.RequestOptions = {
        hostname: CONFIG.apiHost,
        port: CONFIG.apiPort,
        path,
        method,
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 10000,
      };

      const req = http.request(options, (res) => {
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

    const total = this.metrics.success + this.metrics.errors;
    const successRate = total > 0 ? ((this.metrics.success / total) * 100).toFixed(0) : '0';

    console.log(
      `✓ ${this.metrics.success} | ` +
      `✗ ${this.metrics.errors} | ` +
      `Avg: ${avg}ms | ` +
      `Top: ${this.topBid}⭐ | ` +
      `Rate: ${successRate}%`
    );
  }

  async verify(): Promise<void> {
    console.log('═'.repeat(50));
    console.log('  РЕЗУЛЬТАТЫ');
    console.log('═'.repeat(50) + '\n');

    const [totalBids, wonBids] = await Promise.all([
      Bid.countDocuments({ auctionId: this.auctionId }),
      Bid.countDocuments({ auctionId: this.auctionId, status: BidStatus.WON }),
    ]);

    const total = this.metrics.success + this.metrics.errors;
    
    console.log(`Ставок в БД: ${totalBids}`);
    console.log(`Победителей: ${wonBids}`);
    console.log(`API запросов: ${total}`);
    console.log(`Успешных: ${this.metrics.success} (${((this.metrics.success / total) * 100).toFixed(1)}%)`);
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
