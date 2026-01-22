/**
 * Симуляция реалистичного поведения участников аукциона.
 * 
 * Создаёт 50 ботов с разными стратегиями, которые ведут себя как реальные люди:
 * - Не все активны одновременно
 * - Есть "думающие" паузы
 * - Кто-то отваливается из-за цены
 * - Есть снайперы и осторожные игроки
 * 
 * Использование: npx tsx scripts/bots.ts [auctionId]
 */

import mongoose, { Types } from 'mongoose';
import { config } from '../src/config';
import { Auction, AuctionStatus } from '../src/models';
import { userService, bidService, auctionService } from '../src/services';
import { logger } from '../src/utils/logger';

// =====================
// НАСТРОЙКИ
// =====================
const SETTINGS = {
  BOT_COUNT: 50,                    // Количество ботов
  INITIAL_BALANCE: 100000,          // Стартовый баланс каждого бота
  ACTIVE_RATIO: 0.6,                // ~60% ботов активны в момент времени
  THINK_TIME_MIN: 2000,             // Минимальная "пауза на раздумье" (мс)
  THINK_TIME_MAX: 15000,            // Максимальная пауза
  SNIPER_THRESHOLD_MS: 30000,       // Снайперы активизируются за 30 сек до конца
  
  // Настройки демо-аукциона (если не передан ID)
  DEMO_AUCTION: {
    title: 'Демо-аукцион — Лимитированные товары',
    description: 'Автоматическая демонстрация аукциона с ботами',
    totalItems: 30,
    startingPrice: 100,
    minBidIncrement: 10,
    rounds: [
      { items: 10, duration: 90000 },   // 1.5 мин
      { items: 10, duration: 90000 },
      { items: 10, duration: 120000 },  // 2 мин финал
    ],
  },
};

// Имена для ботов — разнообразные, как в реальности
const BOT_NAMES = [
  'Alex', 'Maria', 'Ivan', 'Olga', 'Pavel', 'Anna', 'Sergey', 'Kate',
  'Dmitry', 'Elena', 'Nikita', 'Natasha', 'Anton', 'Julia', 'Maxim', 'Lena',
  'CryptoMax', 'StarHunter', 'GiftPro', 'BidKing', 'TokenFan', 'DigitalAce',
  'BlockRunner', 'MintGuru', 'ChainMaster', 'WalletKid', 'NFTlover', 'CoinBoss',
  'AuctionFan', 'BidWarrior', 'StarChaser', 'GiftSeeker', 'PrizeHunter', 'LuckyOne',
  'FastBidder', 'SlowAndSteady', 'LastSecond', 'FirstPlace', 'TopBidder', 'NewPlayer',
  'Veteran', 'Rookie', 'Champion', 'Contender', 'Challenger', 'Legend', 'Phoenix', 'Storm',
];

// Типы поведения ботов
type BotPersonality = 'aggressive' | 'cautious' | 'sniper' | 'casual' | 'whale';

interface Bot {
  id: Types.ObjectId;
  name: string;
  personality: BotPersonality;
  config: {
    maxBid: number;           // Лимит ставки
    bidMultiplier: number;    // Множитель повышения (1.0 - минимум, 3.0 - агрессивно)
    thinkTimeMs: number;      // Базовое время на раздумье
    sniperChance: number;     // Вероятность снайперской ставки (0-1)
    giveUpThreshold: number;  // При какой цене сдаётся (относительно maxBid)
    activeChance: number;     // Вероятность быть активным в момент времени
  };
  currentBid: number;
  isActive: boolean;
  lastBidTime: number;
}

class BotSimulator {
  private bots: Bot[] = [];
  private auctionId: Types.ObjectId | null = null;
  private isRunning = false;
  private timers: NodeJS.Timeout[] = [];

  /**
   * Генерирует характеристики бота на основе типа личности
   */
  private generateBotConfig(personality: BotPersonality): Bot['config'] {
    switch (personality) {
      case 'aggressive':
        // Агрессивные — много денег, быстрые, высокие ставки
        return {
          maxBid: 15000 + Math.floor(Math.random() * 20000),
          bidMultiplier: 2.0 + Math.random() * 1.5,
          thinkTimeMs: SETTINGS.THINK_TIME_MIN + Math.random() * 3000,
          sniperChance: 0.1,
          giveUpThreshold: 0.95,
          activeChance: 0.8,
        };
        
      case 'cautious':
        // Осторожные — медленно повышают, долго думают
        return {
          maxBid: 3000 + Math.floor(Math.random() * 5000),
          bidMultiplier: 1.0 + Math.random() * 0.5,
          thinkTimeMs: SETTINGS.THINK_TIME_MAX * 0.7 + Math.random() * 5000,
          sniperChance: 0.05,
          giveUpThreshold: 0.7,
          activeChance: 0.4,
        };
        
      case 'sniper':
        // Снайперы — ждут последних секунд
        return {
          maxBid: 8000 + Math.floor(Math.random() * 12000),
          bidMultiplier: 1.5 + Math.random() * 1.0,
          thinkTimeMs: SETTINGS.THINK_TIME_MIN,
          sniperChance: 0.85,
          giveUpThreshold: 0.9,
          activeChance: 0.3, // Мало активны в начале
        };
        
      case 'whale':
        // Киты — большие бюджеты, не жалеют денег
        return {
          maxBid: 30000 + Math.floor(Math.random() * 50000),
          bidMultiplier: 2.5 + Math.random() * 2.0,
          thinkTimeMs: SETTINGS.THINK_TIME_MIN + Math.random() * 5000,
          sniperChance: 0.2,
          giveUpThreshold: 0.98,
          activeChance: 0.7,
        };
        
      case 'casual':
      default:
        // Обычные игроки — средние характеристики
        return {
          maxBid: 5000 + Math.floor(Math.random() * 8000),
          bidMultiplier: 1.2 + Math.random() * 0.8,
          thinkTimeMs: SETTINGS.THINK_TIME_MIN + Math.random() * (SETTINGS.THINK_TIME_MAX - SETTINGS.THINK_TIME_MIN),
          sniperChance: 0.15,
          giveUpThreshold: 0.8,
          activeChance: 0.5,
        };
    }
  }

  /**
   * Распределяет типы личностей по ботам (приближённо к реальности)
   */
  private assignPersonality(index: number): BotPersonality {
    // 5% - киты, 15% - агрессивные, 15% - снайперы, 25% - осторожные, 40% - обычные
    const rand = Math.random();
    if (rand < 0.05) return 'whale';
    if (rand < 0.20) return 'aggressive';
    if (rand < 0.35) return 'sniper';
    if (rand < 0.60) return 'cautious';
    return 'casual';
  }

  async initialize(auctionId?: string): Promise<void> {
    logger.info('Инициализация симуляции...');

    await mongoose.connect(config.mongodb.uri);
    logger.info('Подключено к БД');

    // Создаём ботов с разнообразными характерами
    const usedNames = new Set<string>();
    
    for (let i = 0; i < SETTINGS.BOT_COUNT; i++) {
      // Уникальное имя
      let name: string;
      do {
        const baseName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
        name = baseName + Math.floor(Math.random() * 10000);
      } while (usedNames.has(name));
      usedNames.add(name);

      const personality = this.assignPersonality(i);
      const botConfig = this.generateBotConfig(personality);
      
      const user = await userService.createUser(name, SETTINGS.INITIAL_BALANCE);

      this.bots.push({
        id: user._id as Types.ObjectId,
        name,
        personality,
        config: botConfig,
        currentBid: 0,
        isActive: true,
        lastBidTime: 0,
      });
    }

    // Статистика по типам
    const stats = this.bots.reduce((acc, bot) => {
      acc[bot.personality] = (acc[bot.personality] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    logger.info(`Создано ${this.bots.length} ботов: ${JSON.stringify(stats)}`);

    // Находим или создаём аукцион
    if (auctionId) {
      this.auctionId = new Types.ObjectId(auctionId);
      logger.info(`Используем аукцион: ${this.auctionId}`);
    } else {
      const activeAuction = await Auction.findOne({ status: AuctionStatus.ACTIVE });
      if (activeAuction) {
        this.auctionId = activeAuction._id as Types.ObjectId;
        logger.info(`Найден активный аукцион: ${this.auctionId}`);
      } else {
        await this.createDemoAuction();
      }
    }
  }

  private async createDemoAuction(): Promise<void> {
    const admin = await userService.getOrCreateUser('demo_admin');
    const cfg = SETTINGS.DEMO_AUCTION;

    const auction = await auctionService.createAuction({
      title: cfg.title,
      description: cfg.description,
      totalItems: cfg.totalItems,
      startingPrice: cfg.startingPrice,
      minBidIncrement: cfg.minBidIncrement,
      roundsConfig: cfg.rounds.map(r => ({
        itemsToDistribute: r.items,
        durationMs: r.duration,
      })),
      startTime: new Date(Date.now() + 5000),
      createdBy: admin._id as Types.ObjectId,
    });

    this.auctionId = auction._id as Types.ObjectId;
    logger.info(`Создан демо-аукцион: ${this.auctionId}`);

    // Запуск через 5 секунд
    setTimeout(async () => {
      try {
        const a = await Auction.findById(this.auctionId);
        if (a?.status === AuctionStatus.PENDING) {
          await auctionService.startAuction(this.auctionId!);
          logger.info('🚀 Аукцион запущен!');
        } else if (a?.status === AuctionStatus.ACTIVE) {
          logger.info('Аукцион уже активен');
        }
      } catch (err) {
        logger.error('Ошибка запуска:', err);
      }
    }, 5500);
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info('🤖 Симуляция запущена');

    // Запускаем каждого бота с небольшим разбросом
    for (const bot of this.bots) {
      const delay = Math.random() * 8000; // Случайный старт в первые 8 сек
      setTimeout(() => this.runBotLoop(bot), delay);
    }

    // Мониторинг
    this.monitorAuction();
  }

  private async runBotLoop(bot: Bot): Promise<void> {
    if (!this.isRunning || !bot.isActive) return;

    const tick = async () => {
      if (!this.isRunning || !bot.isActive) return;

      try {
        await this.botTick(bot);
      } catch (err: any) {
        // Тихо игнорируем ошибки "раунд завершён" и т.п.
        if (!err.message?.includes('завершён') && !err.message?.includes('не активен')) {
          logger.debug(`${bot.name}: ${err.message}`);
        }
      }

      // Следующий тик с учётом "времени на раздумья"
      if (this.isRunning && bot.isActive) {
        const nextDelay = bot.config.thinkTimeMs + Math.random() * 5000;
        const timer = setTimeout(tick, nextDelay);
        this.timers.push(timer);
      }
    };

    tick();
  }

  private async botTick(bot: Bot): Promise<void> {
    const auction = await Auction.findById(this.auctionId);
    if (!auction || auction.status !== AuctionStatus.ACTIVE) return;

    const currentRound = auction.rounds[auction.currentRound];
    if (!currentRound || currentRound.status !== 'active') return;

    const timeRemaining = currentRound.endTime.getTime() - Date.now();
    if (timeRemaining <= 0) return;

    // Решаем, действует ли бот сейчас
    if (Math.random() > bot.config.activeChance) {
      return; // "Отошёл от компьютера"
    }

    // После 2 продлений боты прекращают снайперить (устали ждать)
    const extensions = currentRound.extensionCount || 0;
    if (extensions >= 2 && timeRemaining < SETTINGS.SNIPER_THRESHOLD_MS) {
      // 80% ботов уходят после 2 продлений в конце раунда
      if (Math.random() < 0.8) {
        return;
      }
    }

    // Снайперы ждут конца раунда
    if (bot.personality === 'sniper' && timeRemaining > SETTINGS.SNIPER_THRESHOLD_MS) {
      if (Math.random() > 0.1) return; // Снайперы почти не ставят раньше
    }

    // Проверяем текущую ситуацию
    const existingBid = await bidService.getUserBid(this.auctionId!, bot.id);
    const minWinningBid = await bidService.getMinWinningBid(this.auctionId!) || auction.startingPrice;
    
    // Решаем, делать ли ставку
    let shouldBid = false;
    let newBidAmount = 0;

    if (!existingBid) {
      // Первая ставка — все кроме очень осторожных делают
      if (bot.personality !== 'cautious' || Math.random() < 0.5) {
        shouldBid = true;
        const baseIncrement = auction.minBidIncrement * bot.config.bidMultiplier;
        newBidAmount = minWinningBid + Math.ceil(baseIncrement * (0.5 + Math.random()));
      }
    } else {
      // Уже есть ставка — повышаем если нужно
      const position = await bidService.getUserPosition(this.auctionId!, bot.id);
      const isWinning = position && position.position <= currentRound.itemsToDistribute;

      if (!isWinning) {
        // Не в топе — надо повышать
        const increment = auction.minBidIncrement * bot.config.bidMultiplier;
        newBidAmount = minWinningBid + Math.ceil(increment * (0.5 + Math.random() * 0.5));
        shouldBid = true;
      } else if (bot.personality === 'aggressive' && Math.random() < 0.15) {
        // Агрессивные иногда повышают даже когда в топе
        newBidAmount = existingBid.amount + auction.minBidIncrement;
        shouldBid = true;
      }
    }

    if (!shouldBid) return;

    // Проверяем лимит бота
    const giveUpPrice = bot.config.maxBid * bot.config.giveUpThreshold;
    if (newBidAmount > giveUpPrice) {
      if (Math.random() < 0.7) { // 70% шанс сдаться
        bot.isActive = false;
        logger.info(`💸 ${bot.name} (${bot.personality}) вышел — слишком дорого`);
        return;
      }
    }

    if (newBidAmount > bot.config.maxBid) {
      bot.isActive = false;
      logger.info(`🛑 ${bot.name} достиг лимита ${bot.config.maxBid}`);
      return;
    }

    // Делаем ставку
    try {
      const result = await bidService.placeBid(this.auctionId!, bot.id, newBidAmount);
      bot.currentBid = newBidAmount;
      bot.lastBidTime = Date.now();

      const action = result.isNewBid ? 'поставил' : 'повысил до';
      const emoji = bot.personality === 'whale' ? '🐋' : bot.personality === 'sniper' ? '🎯' : '🤖';
      const extension = result.roundExtended ? ' ⏰' : '';
      
      logger.info(`${emoji} ${bot.name} ${action} ${newBidAmount} ⭐${extension}`);
    } catch (err: any) {
      if (err.message.includes('Недостаточно средств')) {
        bot.isActive = false;
        logger.info(`💰 ${bot.name} — закончились деньги`);
      }
    }
  }

  private async monitorAuction(): Promise<void> {
    const check = async () => {
      if (!this.isRunning) return;

      try {
        const auction = await Auction.findById(this.auctionId);
        if (!auction) return;

        if (auction.status === AuctionStatus.COMPLETED) {
          logger.info('🎉 Аукцион завершён!');
          await this.printResults();
          this.stop();
          return;
        }

        const currentRound = auction.rounds[auction.currentRound];
        if (currentRound) {
          const timeRemaining = Math.max(0, currentRound.endTime.getTime() - Date.now());
          const activeBots = this.bots.filter(b => b.isActive).length;
          logger.info(`📊 Раунд ${auction.currentRound + 1}: ${Math.ceil(timeRemaining / 1000)}с, активных ботов: ${activeBots}`);
        }
      } catch (err) {
        logger.error('Ошибка мониторинга:', err);
      }
    };

    const interval = setInterval(check, 10000);
    this.timers.push(interval);
  }

  private async printResults(): Promise<void> {
    try {
      const leaderboard = await bidService.getLeaderboard(this.auctionId!, 50);
      
      logger.info('\n=== ИТОГИ АУКЦИОНА ===');
      leaderboard.slice(0, 10).forEach((bid, i) => {
        const username = (bid.userId as any)?.username || 'Unknown';
        const status = bid.status === 'winner' ? '🏆' : '';
        logger.info(`${i + 1}. ${username}: ${bid.amount} ⭐ ${status}`);
      });
      
      const winners = leaderboard.filter(b => b.status === 'winner').length;
      logger.info(`\nВсего победителей: ${winners}`);
    } catch (err) {
      logger.error('Ошибка получения результатов:', err);
    }
  }

  stop(): void {
    this.isRunning = false;
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
    logger.info('Симуляция остановлена');
  }

  async cleanup(): Promise<void> {
    this.stop();
    await mongoose.disconnect();
  }
}

// Запуск
async function main() {
  const auctionId = process.argv[2];
  const simulator = new BotSimulator();

  process.on('SIGINT', async () => {
    logger.info('\nЗавершение...');
    await simulator.cleanup();
    process.exit(0);
  });

  try {
    await simulator.initialize(auctionId);
    await simulator.start();
    await new Promise(() => {}); // Держим процесс
  } catch (err) {
    logger.error('Ошибка:', err);
    await simulator.cleanup();
    process.exit(1);
  }
}

main();
