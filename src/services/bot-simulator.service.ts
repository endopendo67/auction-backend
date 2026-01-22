import { Types } from 'mongoose';
import { Auction, AuctionStatus, User } from '../models';
import { bidService } from './bid.service';
import { auctionService } from './auction.service';
import { logger } from '../utils/logger';
import { socketHandler } from '../websocket/socket-handler';

interface BotConfig {
  name: string;
  balance: number;
  maxBid: number;
  bidMultiplier: number; // Насколько агрессивно ставит
  snipeChance: number;   // Шанс снайпить в конце раунда
  thinkTimeMs: number;   // Время на "размышление"
}

interface ActiveBot {
  userId: Types.ObjectId;
  config: BotConfig;
  snipeCount: number;    // Сколько раз уже снайпил
  lastBidTime: number;
}

interface AuctionSimulation {
  auctionId: string;
  bots: ActiveBot[];
  interval: NodeJS.Timeout | null;
  isRunning: boolean;
}

const BOT_NAMES = [
  '🤖 Alpha', '🤖 Beta', '🤖 Gamma', '🤖 Delta', '🤖 Epsilon',
  '🤖 Zeta', '🤖 Eta', '🤖 Theta', '🤖 Iota', '🤖 Kappa',
  '🤖 Lambda', '🤖 Mu', '🤖 Nu', '🤖 Xi', '🤖 Omicron',
  '🤖 Pi', '🤖 Rho', '🤖 Sigma', '🤖 Tau', '🤖 Upsilon',
];

const BOT_PERSONALITIES = ['aggressive', 'cautious', 'sniper', 'random'] as const;
type BotPersonality = typeof BOT_PERSONALITIES[number];

/**
 * Сервис симуляции ботов для тестирования аукционов.
 * Боты ставят ставки, перебивают друг друга и снайпят (макс 2 раза).
 */
class BotSimulatorService {
  private simulations: Map<string, AuctionSimulation> = new Map();
  private readonly MAX_SNIPES_PER_BOT = 2;
  private readonly SNIPE_THRESHOLD_MS = 30000; // 30 секунд до конца

  /**
   * Запустить симуляцию ботов для аукциона
   */
  async startSimulation(auctionId: string, botCount = 5): Promise<void> {
    if (this.simulations.has(auctionId)) {
      logger.warn(`Симуляция уже запущена для аукциона ${auctionId}`);
      return;
    }

    const auction = await Auction.findById(auctionId);
    if (!auction || auction.status !== AuctionStatus.ACTIVE) {
      throw new Error('Аукцион не найден или не активен');
    }

    // Создаём ботов
    const bots = await this.createBots(botCount, auction.startingPrice);

    const simulation: AuctionSimulation = {
      auctionId,
      bots,
      interval: null,
      isRunning: true,
    };

    this.simulations.set(auctionId, simulation);

    // Запускаем цикл симуляции
    this.runSimulationLoop(simulation);

    logger.info(`🤖 Симуляция запущена: ${botCount} ботов для аукциона ${auctionId}`);
  }

  /**
   * Остановить симуляцию
   */
  stopSimulation(auctionId: string): void {
    const simulation = this.simulations.get(auctionId);
    if (simulation) {
      simulation.isRunning = false;
      if (simulation.interval) {
        clearInterval(simulation.interval);
      }
      this.simulations.delete(auctionId);
      logger.info(`🤖 Симуляция остановлена для аукциона ${auctionId}`);
    }
  }

  /**
   * Создать ботов с разными характеристиками
   */
  private async createBots(count: number, startingPrice: number): Promise<ActiveBot[]> {
    const bots: ActiveBot[] = [];
    const usedNames = new Set<string>();

    for (let i = 0; i < count; i++) {
      // Уникальное имя
      let name = BOT_NAMES[i % BOT_NAMES.length];
      if (usedNames.has(name)) {
        name = `${name}_${i}`;
      }
      usedNames.add(name);

      // Случайная личность
      const personality = BOT_PERSONALITIES[Math.floor(Math.random() * BOT_PERSONALITIES.length)];
      const config = this.generateBotConfig(name, personality, startingPrice);

      // Создаём или находим пользователя-бота
      let user = await User.findOne({ username: name });
      if (!user) {
        user = await User.create({
          username: name,
          balance: config.balance,
          lockedBalance: 0,
          isBot: true,
        });
      } else {
        // Пополняем баланс если нужно
        if (user.balance < config.balance) {
          user.balance = config.balance;
          await user.save();
        }
      }

      bots.push({
        userId: user._id,
        config,
        snipeCount: 0,
        lastBidTime: 0,
      });
    }

    return bots;
  }

  /**
   * Генерация конфига бота по личности
   */
  private generateBotConfig(name: string, personality: BotPersonality, startingPrice: number): BotConfig {
    const base = {
      name,
      balance: 50000,
      maxBid: startingPrice * 100,
      bidMultiplier: 1.0,
      snipeChance: 0.3,
      thinkTimeMs: 3000,
    };

    switch (personality) {
      case 'aggressive':
        return {
          ...base,
          bidMultiplier: 1.5,
          maxBid: startingPrice * 150,
          thinkTimeMs: 1500,
          snipeChance: 0.2,
        };
      case 'cautious':
        return {
          ...base,
          bidMultiplier: 1.1,
          maxBid: startingPrice * 50,
          thinkTimeMs: 5000,
          snipeChance: 0.1,
        };
      case 'sniper':
        return {
          ...base,
          bidMultiplier: 1.2,
          maxBid: startingPrice * 80,
          thinkTimeMs: 8000,
          snipeChance: 0.8,
        };
      case 'random':
      default:
        return {
          ...base,
          bidMultiplier: 1 + Math.random() * 0.5,
          maxBid: startingPrice * (30 + Math.random() * 70),
          thinkTimeMs: 2000 + Math.random() * 6000,
          snipeChance: Math.random() * 0.5,
        };
    }
  }

  /**
   * Основной цикл симуляции
   */
  private runSimulationLoop(simulation: AuctionSimulation): void {
    const tick = async () => {
      if (!simulation.isRunning) return;

      try {
        const auction = await Auction.findById(simulation.auctionId)
          .select('status currentRound rounds')
          .lean();

        if (!auction || auction.status !== AuctionStatus.ACTIVE) {
          this.stopSimulation(simulation.auctionId);
          return;
        }

        const currentRound = auction.rounds[auction.currentRound];
        if (!currentRound || currentRound.status !== 'active') {
          // Ждём следующего раунда
          setTimeout(tick, 2000);
          return;
        }

        const timeRemaining = new Date(currentRound.endTime).getTime() - Date.now();
        const isSnipeTime = timeRemaining <= this.SNIPE_THRESHOLD_MS && timeRemaining > 0;

        // Выбираем случайного бота для действия
        const bot = this.selectBotForAction(simulation.bots, isSnipeTime);
        if (bot) {
          await this.botAction(simulation.auctionId, bot, isSnipeTime);
        }

      } catch (err) {
        logger.error('Ошибка в симуляции', { error: err, auctionId: simulation.auctionId });
      }

      // Следующий тик через случайный интервал
      if (simulation.isRunning) {
        const delay = 1000 + Math.random() * 3000; // 1-4 секунды
        setTimeout(tick, delay);
      }
    };

    // Первый тик через 2 секунды
    setTimeout(tick, 2000);
  }

  /**
   * Выбор бота для действия
   */
  private selectBotForAction(bots: ActiveBot[], isSnipeTime: boolean): ActiveBot | null {
    const now = Date.now();
    const availableBots = bots.filter(bot => {
      // Бот должен "отдохнуть" после предыдущей ставки
      if (now - bot.lastBidTime < bot.config.thinkTimeMs) return false;
      
      // Если время снайпа — только боты которые ещё не исчерпали лимит
      if (isSnipeTime && bot.snipeCount >= this.MAX_SNIPES_PER_BOT) return false;
      
      return true;
    });

    if (availableBots.length === 0) return null;

    // Случайный выбор с весом на снайперов в конце раунда
    if (isSnipeTime) {
      const snipers = availableBots.filter(b => Math.random() < b.config.snipeChance);
      if (snipers.length > 0) {
        return snipers[Math.floor(Math.random() * snipers.length)];
      }
    }

    return availableBots[Math.floor(Math.random() * availableBots.length)];
  }

  /**
   * Действие бота — сделать ставку
   */
  private async botAction(auctionId: string, bot: ActiveBot, isSnipeTime: boolean): Promise<void> {
    try {
      const auctionOid = new Types.ObjectId(auctionId);
      
      // Получаем текущую ситуацию
      const [leaderboard, userBid, auction] = await Promise.all([
        bidService.getLeaderboard(auctionOid, 10),
        bidService.getUserBid(auctionOid, bot.userId),
        auctionService.getAuction(auctionOid),
      ]);

      if (!auction || auction.status !== AuctionStatus.ACTIVE) return;

      const topBid = leaderboard[0]?.amount || auction.startingPrice;
      const currentBid = userBid?.amount || 0;
      const minIncrement = auction.minBidIncrement || 10;

      // Проверяем, стоит ли делать ставку
      if (currentBid >= bot.config.maxBid) return;

      // Рассчитываем новую ставку
      let newAmount: number;

      if (currentBid === 0) {
        // Первая ставка — близко к стартовой цене
        newAmount = auction.startingPrice + Math.floor(Math.random() * minIncrement * 5);
      } else if (currentBid < topBid) {
        // Перебиваем лидера
        const increment = minIncrement + Math.floor(Math.random() * minIncrement * bot.config.bidMultiplier);
        newAmount = topBid + increment;
      } else {
        // Уже лидер — возможно, повысим ставку
        if (Math.random() > 0.7) return; // 30% шанс пропустить если уже лидер
        newAmount = currentBid + minIncrement;
      }

      // Проверяем лимит
      if (newAmount > bot.config.maxBid) {
        newAmount = bot.config.maxBid;
      }

      // Минимальная проверка
      if (newAmount <= currentBid) return;

      // Делаем ставку
      const result = await bidService.placeBid(auctionOid, bot.userId, newAmount);
      
      // МГНОВЕННО рассылаем через WebSocket всем клиентам
      socketHandler.broadcastBidUpdate(auctionId, result.bid.toJSON());
      
      // Если было продление времени — рассылаем
      if (result.roundExtended) {
        socketHandler.broadcastTimeExtension(auctionId);
      }
      
      bot.lastBidTime = Date.now();
      if (isSnipeTime) {
        bot.snipeCount++;
        logger.debug(`🎯 ${bot.config.name} снайпнул! (${bot.snipeCount}/${this.MAX_SNIPES_PER_BOT})`);
      }

      logger.debug(`🤖 ${bot.config.name} ставит ${newAmount}⭐ (было: ${currentBid})`);

    } catch (err: any) {
      // Игнорируем ошибки недостатка средств и т.п.
      if (!err.message?.includes('Недостаточно') && !err.message?.includes('активен')) {
        logger.debug(`Бот ${bot.config.name} не смог сделать ставку: ${err.message}`);
      }
    }
  }

  /**
   * Получить статус симуляции
   */
  getSimulationStatus(auctionId: string): { isRunning: boolean; botCount: number } | null {
    const simulation = this.simulations.get(auctionId);
    if (!simulation) return null;

    return {
      isRunning: simulation.isRunning,
      botCount: simulation.bots.length,
    };
  }

  /**
   * Остановить все симуляции
   */
  stopAll(): void {
    for (const auctionId of this.simulations.keys()) {
      this.stopSimulation(auctionId);
    }
  }
}

export const botSimulatorService = new BotSimulatorService();

