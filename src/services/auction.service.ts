import { Types } from 'mongoose';
import { Auction, IAuctionDocument, AuctionStatus, IRound } from '../models';
import { config } from '../config';
import { logger } from '../utils/logger';

// Константы для валидации (защита от edge cases)
const LIMITS = {
  MAX_TITLE_LENGTH: 128,
  MAX_DESCRIPTION_LENGTH: 1024,
  MAX_ITEMS: 100000,
  MAX_PRICE: 1_000_000_000, // 1 млрд
  MAX_ROUNDS: 100,
  MIN_ROUND_DURATION_MS: 10000, // 10 секунд минимум
  MAX_ROUND_DURATION_MS: 86400000, // 24 часа максимум
} as const;

export interface CreateAuctionParams {
  title: string;
  description?: string;
  totalItems: number;
  startingPrice: number;
  minBidIncrement?: number;
  roundsConfig: Array<{ itemsToDistribute: number; durationMs: number }>;
  startTime: Date;
  createdBy: Types.ObjectId;
}

export class AuctionService {
  
  async createAuction(params: CreateAuctionParams): Promise<IAuctionDocument> {
    const {
      title,
      description,
      totalItems,
      startingPrice,
      minBidIncrement = config.auction.minBidIncrement,
      roundsConfig,
      startTime,
      createdBy,
    } = params;

    // === EDGE CASE: Валидация входных данных ===
    
    // Пустой или слишком длинный title
    if (!title?.trim()) {
      throw new Error('Название аукциона обязательно');
    }
    if (title.length > LIMITS.MAX_TITLE_LENGTH) {
      throw new Error(`Название слишком длинное (макс ${LIMITS.MAX_TITLE_LENGTH})`);
    }
    
    // Слишком длинное описание
    if (description && description.length > LIMITS.MAX_DESCRIPTION_LENGTH) {
      throw new Error(`Описание слишком длинное (макс ${LIMITS.MAX_DESCRIPTION_LENGTH})`);
    }
    
    // Некорректные числовые значения
    if (!Number.isInteger(totalItems) || totalItems < 1 || totalItems > LIMITS.MAX_ITEMS) {
      throw new Error(`Количество товаров должно быть от 1 до ${LIMITS.MAX_ITEMS}`);
    }
    
    if (!Number.isInteger(startingPrice) || startingPrice < 1 || startingPrice > LIMITS.MAX_PRICE) {
      throw new Error(`Начальная цена должна быть от 1 до ${LIMITS.MAX_PRICE}`);
    }
    
    if (!Number.isInteger(minBidIncrement) || minBidIncrement < 1) {
      throw new Error('Минимальный шаг должен быть положительным целым числом');
    }
    
    // Пустой массив раундов
    if (!roundsConfig?.length) {
      throw new Error('Необходим хотя бы один раунд');
    }
    
    if (roundsConfig.length > LIMITS.MAX_ROUNDS) {
      throw new Error(`Слишком много раундов (макс ${LIMITS.MAX_ROUNDS})`);
    }
    
    // Валидация каждого раунда
    for (let i = 0; i < roundsConfig.length; i++) {
      const rc = roundsConfig[i];
      if (!Number.isInteger(rc.itemsToDistribute) || rc.itemsToDistribute < 1) {
        throw new Error(`Раунд ${i + 1}: количество товаров должно быть >= 1`);
      }
      if (rc.durationMs < LIMITS.MIN_ROUND_DURATION_MS || rc.durationMs > LIMITS.MAX_ROUND_DURATION_MS) {
        throw new Error(`Раунд ${i + 1}: длительность от ${LIMITS.MIN_ROUND_DURATION_MS / 1000}с до ${LIMITS.MAX_ROUND_DURATION_MS / 3600000}ч`);
      }
    }

    // Проверяем что сумма товаров по раундам совпадает с общим количеством
    const totalRoundItems = roundsConfig.reduce((sum, r) => sum + r.itemsToDistribute, 0);
    if (totalRoundItems !== totalItems) {
      throw new Error(`Сумма товаров по раундам (${totalRoundItems}) не равна общему количеству (${totalItems})`);
    }

    // Формируем массив раундов
    let currentTime = new Date(startTime);
    const rounds: IRound[] = roundsConfig.map((cfg, idx) => {
      const roundStart = new Date(currentTime);
      const roundEnd = new Date(currentTime.getTime() + cfg.durationMs);

      const round: IRound = {
        roundNumber: idx,
        itemsToDistribute: cfg.itemsToDistribute,
        startTime: roundStart,
        endTime: roundEnd,
        originalEndTime: roundEnd,
        extensionCount: 0,
        status: 'pending',
        winnersCount: 0,
      };

      currentTime = roundEnd;
      return round;
    });

    const auction = new Auction({
      title,
      description: description || '',
      totalItems,
      startingPrice,
      minBidIncrement,
      rounds,
      currentRound: 0,
      status: AuctionStatus.PENDING,
      startTime,
      createdBy,
    });

    await auction.save();
    logger.info(`Создан аукцион: ${auction.id} "${title}", ${totalItems} товаров`);
    return auction;
  }

  async startAuction(auctionId: Types.ObjectId): Promise<IAuctionDocument> {
    const auction = await Auction.findById(auctionId);
    if (!auction) throw new Error('Аукцион не найден');

    if (auction.status !== AuctionStatus.PENDING) {
      throw new Error(`Нельзя запустить аукцион в статусе: ${auction.status}`);
    }

    const now = new Date();
    auction.status = AuctionStatus.ACTIVE;
    auction.rounds[0].status = 'active';
    auction.rounds[0].startTime = now;

    // Пересчитываем время окончания от текущего момента
    const duration = auction.rounds[0].originalEndTime.getTime() - auction.rounds[0].startTime.getTime();
    auction.rounds[0].endTime = new Date(now.getTime() + duration);
    auction.rounds[0].originalEndTime = auction.rounds[0].endTime;

    await auction.save();
    logger.info(`Аукцион запущен: ${auctionId}`);
    return auction;
  }

  async getAuction(auctionId: Types.ObjectId): Promise<IAuctionDocument | null> {
    return Auction.findById(auctionId).populate('createdBy', 'username');
  }

  async getActiveAuctions(): Promise<IAuctionDocument[]> {
    return Auction.find({ status: AuctionStatus.ACTIVE })
      .sort({ startTime: -1 })
      .populate('createdBy', 'username');
  }

  async getAllAuctions(page = 1, limit = 20): Promise<{ auctions: IAuctionDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [auctions, total] = await Promise.all([
      Auction.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('createdBy', 'username'),
      Auction.countDocuments(),
    ]);

    return { auctions, total };
  }

  /**
   * Продление времени раунда (anti-sniping).
   * Если ставка сделана в последние N секунд - добавляем время.
   * Лимита нет — участники сами решают, продолжать ли торги.
   */
  async extendRoundTime(auctionId: Types.ObjectId): Promise<boolean> {
    const auction = await Auction.findById(auctionId);
    if (!auction || auction.status !== AuctionStatus.ACTIVE) return false;

    const currentRound = auction.rounds[auction.currentRound];
    if (!currentRound || currentRound.status !== 'active') return false;

    const now = Date.now();
    const timeToEnd = currentRound.endTime.getTime() - now;

    // Если до конца осталось меньше порога - продлеваем
    if (timeToEnd > 0 && timeToEnd <= config.auction.antiSnipeThresholdMs) {
      const newEndTime = new Date(now + config.auction.antiSnipeExtensionMs);

      await Auction.updateOne(
        { _id: auctionId },
        {
          $set: { [`rounds.${auction.currentRound}.endTime`]: newEndTime },
          $inc: { [`rounds.${auction.currentRound}.extensionCount`]: 1 },
        }
      );

      logger.info(`Anti-snipe: раунд продлён (#${currentRound.extensionCount + 1}), auction=${auctionId}`);
      return true;
    }

    return false;
  }

  async checkRoundCompletion(auctionId: Types.ObjectId): Promise<boolean> {
    // Оптимизация: lean + select только нужные поля
    const auction = await Auction.findById(auctionId)
      .select('status currentRound rounds')
      .lean();
    
    if (!auction || auction.status !== AuctionStatus.ACTIVE) return false;

    const currentRound = auction.rounds[auction.currentRound];
    if (!currentRound || currentRound.status !== 'active') return false;

    return Date.now() >= currentRound.endTime.getTime();
  }

  async advanceToNextRound(auctionId: Types.ObjectId): Promise<IAuctionDocument | null> {
    const auction = await Auction.findById(auctionId);
    if (!auction) return null;

    const nextRoundIndex = auction.currentRound + 1;

    if (nextRoundIndex >= auction.rounds.length) {
      // Больше раундов нет - аукцион завершён
      auction.status = AuctionStatus.COMPLETED;
      auction.endTime = new Date();
      await auction.save();
      logger.info(`Аукцион завершён: ${auctionId}`);
      return auction;
    }

    // Запускаем следующий раунд
    const now = new Date();
    const nextRound = auction.rounds[nextRoundIndex];
    const duration = nextRound.originalEndTime.getTime() - nextRound.startTime.getTime();

    auction.currentRound = nextRoundIndex;
    auction.rounds[nextRoundIndex].status = 'active';
    auction.rounds[nextRoundIndex].startTime = now;
    auction.rounds[nextRoundIndex].endTime = new Date(now.getTime() + duration);
    auction.rounds[nextRoundIndex].originalEndTime = auction.rounds[nextRoundIndex].endTime;

    await auction.save();
    logger.info(`Переход к раунду ${nextRoundIndex}, auction=${auctionId}`);
    return auction;
  }

  async markRoundCompleted(auctionId: Types.ObjectId, winnersCount: number): Promise<void> {
    const auction = await Auction.findById(auctionId);
    if (!auction) throw new Error('Аукцион не найден');

    await Auction.updateOne(
      { _id: auctionId },
      {
        $set: {
          [`rounds.${auction.currentRound}.status`]: 'completed',
          [`rounds.${auction.currentRound}.winnersCount`]: winnersCount,
        },
        $inc: { distributedItems: winnersCount },
      }
    );
  }

  async getCurrentRoundInfo(auctionId: Types.ObjectId): Promise<{
    round: IRound;
    timeRemainingMs: number;
    isLastRound: boolean;
  } | null> {
    // Оптимизация: lean + select
    const auction = await Auction.findById(auctionId)
      .select('status currentRound rounds')
      .lean();
    
    if (!auction || auction.status !== AuctionStatus.ACTIVE) return null;

    const round = auction.rounds[auction.currentRound];
    if (!round) return null;

    return {
      round,
      timeRemainingMs: Math.max(0, new Date(round.endTime).getTime() - Date.now()),
      isLastRound: auction.currentRound === auction.rounds.length - 1,
    };
  }

  /**
   * Отмена аукциона (edge case: нужно вернуть все заблокированные средства)
   */
  async cancelAuction(auctionId: Types.ObjectId): Promise<IAuctionDocument> {
    const auction = await Auction.findById(auctionId);
    if (!auction) throw new Error('Аукцион не найден');

    if (auction.status === AuctionStatus.COMPLETED) {
      throw new Error('Нельзя отменить завершённый аукцион');
    }

    auction.status = AuctionStatus.CANCELLED;
    auction.endTime = new Date();
    await auction.save();

    logger.info(`Аукцион отменён: ${auctionId}`);
    return auction;
  }
}

export const auctionService = new AuctionService();
