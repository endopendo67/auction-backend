/**
 * Скрипт для симуляции ботов на аукционе.
 * Создаёт виртуальных участников, которые делают ставки с разными стратегиями.
 * 
 * Использование: npx tsx scripts/bots.ts [auctionId]
 */

import mongoose, { Types } from 'mongoose';
import { config } from '../src/config';
import { Auction, AuctionStatus } from '../src/models';
import { userService, bidService, auctionService } from '../src/services';
import { logger } from '../src/utils/logger';

// Имена для ботов — чтобы было похоже на реальных юзеров
const BOT_NAMES = [
  'CryptoKing', 'StarCollector', 'GiftHunter', 'AuctionPro',
  'BidMaster', 'TokenSeeker', 'DigitalNinja', 'BlockchainBoss',
  'NFTWhale', 'CoinChaser', 'BitBidder', 'EtherExpert',
  'DeFiDuke', 'MintMaster', 'ChainChamp', 'WalletWizard',
];

interface Bot {
  id: Types.ObjectId;
  name: string;
  personality: {
    aggression: number;      // насколько агрессивно повышает ставки
    patience: number;        // базовая задержка между ставками (мс)
    sniperChance: number;    // шанс ставить в последние секунды
    maxBid: number;          // максимальная ставка
  };
  currentBid: number;
  isActive: boolean;
}

class BotManager {
  private bots: Bot[] = [];
  private auctionId: Types.ObjectId | null = null;
  private isRunning = false;
  private botIntervals: NodeJS.Timeout[] = [];

  async initialize(auctionId?: string): Promise<void> {
    logger.info('Инициализация ботов...');

    await mongoose.connect(config.mongodb.uri);
    logger.info('Подключено к БД');

    // Создаём ботов с разными характерами
    for (let i = 0; i < 8; i++) {
      const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] +
        Math.floor(Math.random() * 1000);

      const user = await userService.createUser(name, 50000);

      this.bots.push({
        id: user._id as Types.ObjectId,
        name,
        personality: {
          aggression: 0.2 + Math.random() * 0.8,
          patience: 3000 + Math.random() * 7000,
          sniperChance: Math.random() * 0.3,
          maxBid: 5000 + Math.floor(Math.random() * 10000),
        },
        currentBid: 0,
        isActive: true,
      });
    }

    logger.info(`Создано ${this.bots.length} ботов`);

    // Находим или создаём аукцион
    if (auctionId) {
      this.auctionId = new Types.ObjectId(auctionId);
    } else {
      const activeAuction = await Auction.findOne({ status: AuctionStatus.ACTIVE });
      if (activeAuction) {
        this.auctionId = activeAuction._id as Types.ObjectId;
        logger.info(`Используем активный аукцион: ${this.auctionId}`);
      } else {
        await this.createDemoAuction();
      }
    }
  }

  private async createDemoAuction(): Promise<void> {
    const admin = await userService.getOrCreateUser('demo_admin');

    const auction = await auctionService.createAuction({
      title: 'Демо аукцион — Лимитированные товары',
      description: 'Автоматическая демонстрация работы аукциона',
      totalItems: 30,
      startingPrice: 100,
      minBidIncrement: 10,
      roundsConfig: [
        { itemsToDistribute: 10, durationMs: 60000 },
        { itemsToDistribute: 10, durationMs: 60000 },
        { itemsToDistribute: 10, durationMs: 90000 },
      ],
      startTime: new Date(Date.now() + 3000),
      createdBy: admin._id as Types.ObjectId,
    });

    this.auctionId = auction._id as Types.ObjectId;
    logger.info(`Создан демо-аукцион: ${this.auctionId}`);

    // Автозапуск через 3.5 секунды (если ещё не запущен)
    setTimeout(async () => {
      try {
        const auction = await Auction.findById(this.auctionId);
        if (!auction) {
          logger.error('Аукцион не найден');
          return;
        }

        if (auction.status === AuctionStatus.PENDING) {
          await auctionService.startAuction(this.auctionId!);
          logger.info('Аукцион запущен');
        } else if (auction.status === AuctionStatus.ACTIVE) {
          logger.info('Аукцион уже активен, продолжаем');
        } else {
          logger.warn(`Аукцион в статусе ${auction.status}, запуск невозможен`);
        }
      } catch (err) {
        logger.error('Ошибка запуска аукциона:', err);
      }
    }, 3500);
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info('Боты запущены');

    for (const bot of this.bots) {
      this.startBotLoop(bot);
    }

    this.monitorAuction();
  }

  private startBotLoop(bot: Bot): void {
    const makeBid = async () => {
      if (!this.isRunning || !bot.isActive) return;

      try {
        const auction = await Auction.findById(this.auctionId);
        if (!auction || auction.status !== AuctionStatus.ACTIVE) return;

        const currentRound = auction.rounds[auction.currentRound];
        if (!currentRound || currentRound.status !== 'active') return;

        const timeRemaining = currentRound.endTime.getTime() - Date.now();

        // Снайпер-логика — выше шанс ставить в конце раунда
        if (timeRemaining > 30000 && Math.random() > bot.personality.sniperChance) {
          if (Math.random() > 0.3) return;
        }

        const existingBid = await bidService.getUserBid(this.auctionId!, bot.id);
        const minWinningBid = await bidService.getMinWinningBid(this.auctionId!);

        let newBidAmount: number;
        if (existingBid) {
          // Уже есть ставка — может повысить
          if (minWinningBid && existingBid.amount < minWinningBid) {
            const increment = Math.ceil(auction.minBidIncrement * (1 + bot.personality.aggression * 2));
            newBidAmount = minWinningBid + increment;
          } else {
            // Уже в топе — иногда всё равно повышаем
            if (Math.random() < 0.2 * bot.personality.aggression) {
              newBidAmount = existingBid.amount + auction.minBidIncrement;
            } else {
              return;
            }
          }
        } else {
          // Первая ставка
          const baseBid = minWinningBid || auction.startingPrice;
          const increment = Math.ceil(auction.minBidIncrement * bot.personality.aggression * 3);
          newBidAmount = baseBid + increment;
        }

        // Проверяем лимит бота
        if (newBidAmount > bot.personality.maxBid) {
          bot.isActive = false;
          logger.info(`🤖 ${bot.name} достиг лимита, выходит из игры`);
          return;
        }

        const result = await bidService.placeBid(this.auctionId!, bot.id, newBidAmount);
        bot.currentBid = newBidAmount;

        const action = result.isNewBid ? 'поставил' : 'повысил до';
        logger.info(`🤖 ${bot.name} ${action} ${newBidAmount} ⭐` + (result.roundExtended ? ' (время продлено!)' : ''));

      } catch (err: any) {
        if (err.message.includes('Недостаточно средств')) {
          bot.isActive = false;
          logger.info(`🤖 ${bot.name} — закончились деньги`);
        } else if (!err.message.includes('завершён') && !err.message.includes('не активен')) {
          logger.warn(`Ошибка бота ${bot.name}: ${err.message}`);
        }
      }
    };

    // Стартуем с небольшой случайной задержкой
    const initialDelay = Math.random() * 5000;
    setTimeout(() => {
      if (!this.isRunning) return;

      makeBid();

      const interval = setInterval(() => {
        if (!this.isRunning || !bot.isActive) {
          clearInterval(interval);
          return;
        }
        makeBid();
      }, bot.personality.patience);

      this.botIntervals.push(interval);
    }, initialDelay);
  }

  private async monitorAuction(): Promise<void> {
    const checkStatus = async () => {
      if (!this.isRunning) return;

      try {
        const auction = await Auction.findById(this.auctionId);
        if (!auction) return;

        if (auction.status === AuctionStatus.COMPLETED) {
          logger.info('🎉 Аукцион завершён!');
          this.stop();
          return;
        }

        const currentRound = auction.rounds[auction.currentRound];
        if (currentRound) {
          const timeRemaining = Math.max(0, currentRound.endTime.getTime() - Date.now());
          logger.debug(`Раунд ${auction.currentRound + 1}: осталось ${Math.ceil(timeRemaining / 1000)}с`);
        }
      } catch (err) {
        logger.error('Ошибка мониторинга:', err);
      }
    };

    const monitorInterval = setInterval(checkStatus, 5000);
    this.botIntervals.push(monitorInterval);
  }

  stop(): void {
    this.isRunning = false;
    this.botIntervals.forEach(i => clearInterval(i));
    this.botIntervals = [];
    logger.info('Боты остановлены');
  }

  async cleanup(): Promise<void> {
    this.stop();
    await mongoose.disconnect();
  }
}

// Запуск
async function main() {
  const auctionId = process.argv[2];
  const manager = new BotManager();

  process.on('SIGINT', async () => {
    logger.info('Завершение...');
    await manager.cleanup();
    process.exit(0);
  });

  try {
    await manager.initialize(auctionId);
    await manager.start();
    await new Promise(() => {}); // держим процесс
  } catch (err) {
    logger.error('Ошибка:', err);
    await manager.cleanup();
    process.exit(1);
  }
}

main();
