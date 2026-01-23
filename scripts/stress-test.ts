/**
 * СТРЕСС-ТЕСТ СИСТЕМЫ АУКЦИОНОВ
 * 
 * ВАЖНО: Использует HTTP API для корректной рассылки WebSocket!
 * 
 * - 5000 предметов
 * - 5 раундов по 30 секунд
 * - 6000 ботов
 * - Постоянные ставки и перебивание через API
 * 
 * Использование: npx tsx scripts/stress-test.ts
 */

import mongoose, { Types } from 'mongoose';
import { config } from '../src/config';
import { User, Auction, Bid, AuctionStatus, BidStatus } from '../src/models';
import { userService, auctionService, redisService } from '../src/services';

const CONFIG = {
  totalItems: 5000,
  rounds: 5,
  roundDurationSec: 30,
  totalBots: 6000,
  initialBalance: 100000,
  targetRPS: 300,
  apiBaseUrl: process.env.API_URL || 'http://localhost:80',
};

// HTTP клиент с connection pooling
import http from 'http';
const agent = new http.Agent({ 
  keepAlive: true, 
  maxSockets: 100,
  keepAliveMsecs: 30000,
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
    wsUpdates: 0,
  };
  private isRunning = false;
  private topBid = 100;
  private minIncrement = 10;

  async initialize(): Promise<void> {
    console.log('\n🚀 Инициализация стресс-теста\n');
    console.log(`API: ${CONFIG.apiBaseUrl}`);
    
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
    this.auctionIdStr = this.auctionId.toString();
    this.minIncrement = auction.minBidIncrement || 10;
    this.topBid = auction.startingPrice;
    
    console.log(`✓ Аукцион: ${CONFIG.totalItems} товаров, ${CONFIG.rounds} раундов по ${CONFIG.roundDurationSec}с`);
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
    console.log('  ЗАПУСК СТРЕСС-ТЕСТА (через HTTP API)');
    console.log('═'.repeat(50));
    console.log(`  Товаров: ${CONFIG.totalItems}`);
    console.log(`  Раундов: ${CONFIG.rounds} × ${CONFIG.roundDurationSec}с`);
    console.log(`  Ботов: ${CONFIG.totalBots}`);
    console.log(`  Целевой RPS: ${CONFIG.targetRPS}`);
    console.log('═'.repeat(50) + '\n');

    // Ждём старта и запускаем
    const auction = await Auction.findById(this.auctionId);
    if (auction?.status === AuctionStatus.PENDING) {
      const wait = auction.startTime.getTime() - Date.now();
      if (wait > 0) {
        console.log(`Ожидание старта: ${Math.ceil(wait / 1000)}с...`);
        await new Promise(r => setTimeout(r, wait + 500));
      }
      
      // Запускаем через API (важно для WebSocket!)
      await this.callApi('POST', `/api/auctions/${this.auctionIdStr}/start`, {});
      console.log('✓ Аукцион запущен через API\n');
    }

    this.isRunning = true;

    // Мониторинг каждые 3 секунды
    const monitor = setInterval(() => this.printStatus(), 3000);

    // Обновление topBid каждые 500ms
    const topBidUpdater = setInterval(async () => {
      try {
        const bid = await Bid.findOne({ auctionId: this.auctionId })
          .sort({ amount: -1 })
          .select('amount')
          .lean();
        if (bid) this.topBid = bid.amount;
      } catch {}
    }, 500);

    // Генерация нагрузки
    const promises: Promise<void>[] = [];
    const interval = setInterval(async () => {
      if (!this.isRunning) return;

      // Проверка статуса аукциона
      const auctionCheck = await Auction.findById(this.auctionId).select('status').lean();
      if (auctionCheck?.status !== AuctionStatus.ACTIVE) {
        this.isRunning = false;
        clearInterval(interval);
        clearInterval(topBidUpdater);
        return;
      }

      // Генерация ставок через API
      const bidsPerTick = Math.ceil(CONFIG.targetRPS / 10);
      for (let i = 0; i < bidsPerTick; i++) {
        const bot = this.bots[Math.floor(Math.random() * this.bots.length)];
        promises.push(this.makeBidViaApi(bot));
      }
    }, 100);

    // Ждём завершения аукциона или таймаута
    const maxTime = CONFIG.rounds * CONFIG.roundDurationSec * 1000 + 60000;
    await new Promise(r => setTimeout(r, maxTime));
    this.isRunning = false;
    clearInterval(interval);
    clearInterval(monitor);
    clearInterval(topBidUpdater);

    console.log('\nОжидание завершения ставок...');
    await Promise.allSettled(promises);

    console.log('✓ Тест завершён\n');
  }

  /**
   * Делаем ставку через HTTP API — так WebSocket рассылка работает!
   */
  private async makeBidViaApi(bot: Bot): Promise<void> {
    const start = performance.now();
    this.metrics.bids++;

    try {
      // Вычисляем новую ставку
      let amount: number;

      if (bot.currentBid === 0) {
        // Первая ставка
        amount = this.topBid + Math.floor(Math.random() * this.minIncrement * 3);
      } else if (bot.currentBid < this.topBid) {
        // Перебиваем лидера
        const increment = this.minIncrement * (1 + Math.floor(Math.random() * 5));
        amount = this.topBid + increment;
      } else {
        // Уже лидер — иногда повышаем
        if (Math.random() > 0.3) return;
        amount = bot.currentBid + this.minIncrement * Math.floor(1 + Math.random() * 3);
      }

      // HTTP POST к API
      const response = await this.callApi('POST', `/api/auctions/${this.auctionIdStr}/bids`, {
        userId: bot.id.toString(),
        amount,
      });

      if (response.success) {
        bot.currentBid = amount;
        if (amount > this.topBid) this.topBid = amount;
        
        const latency = performance.now() - start;
        this.metrics.success++;
        this.metrics.latencies.push(latency);

        if (this.metrics.latencies.length > 1000) {
          this.metrics.latencies = this.metrics.latencies.slice(-1000);
        }
      } else {
        this.metrics.errors++;
      }
    } catch (err: any) {
      this.metrics.errors++;
    }
  }

  /**
   * HTTP вызов к API
   */
  private callApi(method: string, path: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, CONFIG.apiBaseUrl);
      const data = JSON.stringify(body);

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method,
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
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

    const rps = Math.round(this.metrics.success / 3); // За последние 3 секунды

    console.log(
      `Ставки: ${this.metrics.success} | ` +
      `Ошибки: ${this.metrics.errors} | ` +
      `Avg: ${avg}ms | ` +
      `TopBid: ${this.topBid}⭐`
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
