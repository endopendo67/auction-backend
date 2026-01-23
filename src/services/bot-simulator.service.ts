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
  totalSnipeCount: number; // Общий счётчик снайпов для всей симуляции
}

const BOT_NAMES = [
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon',
  'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa',
  'Lambda', 'Omega', 'Nova', 'Orion', 'Vega',
  'Atlas', 'Titan', 'Nexus', 'Pulse', 'Storm',
  'Blaze', 'Cyber', 'Flash', 'Spark', 'Turbo',
  'Nitro', 'Rapid', 'Swift', 'Hyper', 'Ultra',
];

const BOT_PERSONALITIES = ['aggressive', 'cautious', 'sniper', 'random'] as const;
type BotPersonality = typeof BOT_PERSONALITIES[number];

/**
 * Сервис симуляции ботов для тестирования аукционов.
 * Боты ставят ставки, перебивают друг друга и снайпят (макс 2 раза за всю симуляцию).
 */
class BotSimulatorService {
  private simulations: Map<string, AuctionSimulation> = new Map();
  private readonly MAX_TOTAL_SNIPES = 2; // Общий лимит снайпов для всей симуляции
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
      totalSnipeCount: 0,
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
   * Создать ботов ПАРАЛЛЕЛЬНО для хаотичности
   */
  private async createBots(count: number, startingPrice: number): Promise<ActiveBot[]> {
    const bots: ActiveBot[] = [];
    const batchSize = 50;
    
    // Создаём батчами параллельно
    for (let i = 0; i < count; i += batchSize) {
      const batch: Promise<ActiveBot>[] = [];
      const end = Math.min(i + batchSize, count);
      
      for (let j = i; j < end; j++) {
        const name = j < BOT_NAMES.length ? BOT_NAMES[j] : `Bot_${j}`;
        const personality = BOT_PERSONALITIES[Math.floor(Math.random() * BOT_PERSONALITIES.length)];
        
        batch.push(this.createSingleBot(name, personality, startingPrice));
      }
      
      const created = await Promise.all(batch);
      bots.push(...created);
    }

    logger.info(`Создано ${bots.length} ботов параллельно`);
    return bots;
  }

  private async createSingleBot(name: string, personality: BotPersonality, startingPrice: number): Promise<ActiveBot> {
    const config = this.generateBotConfig(name, personality, startingPrice);

    let user = await User.findOne({ username: name });
    if (!user) {
      user = await User.create({
        username: name,
        balance: config.balance,
        lockedBalance: 0,
        isBot: true,
      });
    } else if (user.balance < config.balance) {
      user.balance = config.balance;
      await user.save();
    }

    return {
      userId: user._id,
      config,
      snipeCount: 0,
      lastBidTime: 0,
    };
  }

  /**
   * Генерация конфига бота (ХАОТИЧНЫЕ настройки)
   */
  private generateBotConfig(name: string, personality: BotPersonality, startingPrice: number): BotConfig {
    // Очень низкое время размышления для хаоса
    const base = {
      name,
      balance: 200000,
      maxBid: startingPrice * 500,
      bidMultiplier: 3.0 + Math.random() * 5.0, // 3-8x!
      snipeChance: 0.7,
      thinkTimeMs: 50 + Math.random() * 200, // 50-250ms — почти мгновенно
    };

    switch (personality) {
      case 'aggressive':
        return {
          ...base,
          bidMultiplier: 5.0 + Math.random() * 10.0, // 5-15x агрессия!
          maxBid: startingPrice * 1000,
          thinkTimeMs: 10 + Math.random() * 50, // 10-60ms
          snipeChance: 0.8,
        };
      case 'cautious':
        return {
          ...base,
          bidMultiplier: 1.0 + Math.random() * 2.0,
          maxBid: startingPrice * 200,
          thinkTimeMs: 100 + Math.random() * 300,
          snipeChance: 0.4,
        };
      case 'sniper':
        return {
          ...base,
          bidMultiplier: 2.0 + Math.random() * 3.0,
          maxBid: startingPrice * 400,
          thinkTimeMs: 50 + Math.random() * 100,
          snipeChance: 0.95, // Почти всегда снайпит
        };
      case 'random':
      default:
        return {
          ...base,
          bidMultiplier: Math.random() * 8.0, // 0-8x полный хаос
          maxBid: startingPrice * (100 + Math.random() * 400),
          thinkTimeMs: Math.random() * 500,
          snipeChance: Math.random(),
        };
    }
  }

  /**
   * Основной цикл симуляции (ХАОТИЧНЫЙ режим)
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
          setTimeout(tick, 1000);
          return;
        }

        const timeRemaining = new Date(currentRound.endTime).getTime() - Date.now();
        const isSnipeTime = timeRemaining <= this.SNIPE_THRESHOLD_MS && timeRemaining > 0;

        // ХАОС: Выбираем 3-10 ботов для одновременных действий!
        const botsToAct = Math.floor(3 + Math.random() * 8);
        const actions: Promise<void>[] = [];
        
        for (let i = 0; i < botsToAct; i++) {
          const bot = this.selectBotForAction(simulation, isSnipeTime);
          if (bot) {
            // Запускаем ставки параллельно (не ждём завершения)
            actions.push(this.botAction(simulation, bot, isSnipeTime));
          }
        }
        
        // Не ждём завершения — пусть идут параллельно
        Promise.all(actions).catch(() => {});

      } catch (err) {
        logger.error('Ошибка в симуляции', { error: err, auctionId: simulation.auctionId });
      }

      // ХАОТИЧНЫЙ интервал: 50-300ms
      if (simulation.isRunning) {
        const delay = 50 + Math.random() * 250;
        setTimeout(tick, delay);
      }
    };

    // Начинаем сразу
    setTimeout(tick, 100);
  }

  /**
   * Выбор бота для действия (ХАОТИЧНЫЙ)
   */
  private selectBotForAction(simulation: AuctionSimulation, isSnipeTime: boolean): ActiveBot | null {
    const now = Date.now();
    
    // Если общий лимит снайпов исчерпан — не снайпим
    const canSnipe = simulation.totalSnipeCount < this.MAX_TOTAL_SNIPES;
    
    const availableBots = simulation.bots.filter(bot => {
      // Минимальная пауза 50ms чтобы избежать спама от одного бота
      if (now - bot.lastBidTime < 50) return false;
      return true;
    });

    if (availableBots.length === 0) return null;

    // В режиме снайпа — приоритет снайперам
    if (isSnipeTime && canSnipe) {
      const snipers = availableBots.filter(b => Math.random() < b.config.snipeChance);
      if (snipers.length > 0) {
        return snipers[Math.floor(Math.random() * snipers.length)];
      }
    }

    // Полностью случайный выбор
    return availableBots[Math.floor(Math.random() * availableBots.length)];
  }

  /**
   * Действие бота — сделать ставку
   */
  private async botAction(simulation: AuctionSimulation, bot: ActiveBot, isSnipeTime: boolean): Promise<void> {
    try {
      const auctionOid = new Types.ObjectId(simulation.auctionId);
      
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

      // НЕПРЕДСКАЗУЕМАЯ ставка с резкими скачками
      let newAmount: number;

      if (currentBid === 0) {
        // Первая ставка — случайный скачок от стартовой
        const jump = Math.floor(Math.random() * minIncrement * 20);
        newAmount = auction.startingPrice + jump;
      } else if (currentBid < topBid) {
        // Агрессивное перебивание с большими скачками
        const aggressiveness = Math.random() < 0.3 ? 10 : 1; // 30% шанс на очень большой скачок
        const increment = minIncrement * bot.config.bidMultiplier * aggressiveness;
        newAmount = topBid + Math.floor(increment + Math.random() * increment);
      } else {
        // Уже лидер — случайно повышаем
        if (Math.random() > 0.7) return; // 70% шанс повысить
        const jump = minIncrement * Math.floor(1 + Math.random() * 10);
        newAmount = currentBid + jump;
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
      socketHandler.broadcastBidUpdate(simulation.auctionId, result.bid.toJSON());
      
      // Если было продление времени — рассылаем
      if (result.roundExtended) {
        socketHandler.broadcastTimeExtension(simulation.auctionId);
      }
      
      bot.lastBidTime = Date.now();
      
      // Учитываем снайп в общем счётчике (макс 2 за всю симуляцию)
      if (isSnipeTime && simulation.totalSnipeCount < this.MAX_TOTAL_SNIPES) {
        simulation.totalSnipeCount++;
        logger.info(`🎯 ${bot.config.name} снайпнул! (всего ${simulation.totalSnipeCount}/${this.MAX_TOTAL_SNIPES})`);
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

