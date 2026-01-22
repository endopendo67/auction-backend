import { Types } from 'mongoose';
import { Auction, IAuctionDocument, AuctionStatus, IRound } from '../models';
import { config } from '../config';
import { logger } from '../utils/logger';

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
    const auction = await Auction.findById(auctionId);
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
    const auction = await Auction.findById(auctionId);
    if (!auction || auction.status !== AuctionStatus.ACTIVE) return null;

    const round = auction.rounds[auction.currentRound];
    if (!round) return null;

    return {
      round,
      timeRemainingMs: Math.max(0, round.endTime.getTime() - Date.now()),
      isLastRound: auction.currentRound === auction.rounds.length - 1,
    };
  }
}

export const auctionService = new AuctionService();
