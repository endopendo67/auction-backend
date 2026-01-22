import mongoose, { Types, ClientSession } from 'mongoose';
import { Bid, IBidDocument, BidStatus, Auction, AuctionStatus } from '../models';
import { balanceService } from './balance.service';
import { auctionService } from './auction.service';
import { redisService } from './redis.service';
import { config } from '../config';
import { logger } from '../utils/logger';

// Лимиты для защиты от edge cases
const LIMITS = {
  MAX_BID_AMOUNT: 1_000_000_000, // 1 млрд
  MIN_TIME_BUFFER_MS: 100, // буфер на случай ставки на границе времени
} as const;

export interface PlaceBidResult {
  bid: IBidDocument;
  isNewBid: boolean;
  previousAmount?: number;
  roundExtended: boolean;
}

/**
 * Сервис ставок.
 * Вся логика размещения ставок с гарантией конкурентности через транзакции.
 */
export class BidService {
  // Максимальное кол-во попыток при конфликте транзакций
  private readonly MAX_RETRY_ATTEMPTS = 5; // увеличено для высокой нагрузки

  /**
   * Размещение или повышение ставки с повтором при конфликте.
   * Включает rate limiting для защиты от спама.
   */
  async placeBid(
    auctionId: Types.ObjectId,
    userId: Types.ObjectId,
    amount: number
  ): Promise<PlaceBidResult> {
    // EDGE CASE: Rate limiting — макс 10 ставок в 5 секунд от одного пользователя
    const rateLimit = await redisService.checkRateLimit(
      `bid:${userId}`,
      10, // max requests
      5   // window seconds
    );
    
    if (!rateLimit.allowed) {
      throw new Error('Слишком много запросов. Подождите немного');
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.placeBidInternal(auctionId, userId, amount);
      } catch (err: any) {
        // WriteConflict - повторяем
        if (err.code === 112 || err.message?.includes('WriteConflict')) {
          lastError = err;
          const delay = Math.pow(2, attempt) * 50 + Math.random() * 50;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('Не удалось разместить ставку после нескольких попыток');
  }

  private async placeBidInternal(
    auctionId: Types.ObjectId,
    userId: Types.ObjectId,
    amount: number
  ): Promise<PlaceBidResult> {
    // === EDGE CASE: Валидация суммы до начала транзакции ===
    if (!Number.isInteger(amount) || amount < 1) {
      throw new Error('Сумма ставки должна быть положительным целым числом');
    }
    if (amount > LIMITS.MAX_BID_AMOUNT) {
      throw new Error(`Максимальная ставка: ${LIMITS.MAX_BID_AMOUNT}`);
    }

    const session = await mongoose.startSession();
    
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });

      // Валидация аукциона (lean для скорости, потом полный объект если нужен)
      const auction = await Auction.findById(auctionId).session(session);
      if (!auction) throw new Error('Аукцион не найден');
      if (auction.status !== AuctionStatus.ACTIVE) {
        throw new Error(`Аукцион не активен (статус: ${auction.status})`);
      }

      const currentRound = auction.rounds[auction.currentRound];
      if (!currentRound || currentRound.status !== 'active') {
        throw new Error('Нет активного раунда');
      }

      // EDGE CASE: Ставка на границе времени (добавляем буфер)
      const timeToEnd = currentRound.endTime.getTime() - Date.now();
      if (timeToEnd <= LIMITS.MIN_TIME_BUFFER_MS) {
        throw new Error('Раунд завершается, попробуйте позже');
      }

      // EDGE CASE: Ставка ниже стартовой цены
      if (amount < auction.startingPrice) {
        throw new Error(`Минимальная ставка: ${auction.startingPrice}`);
      }

      // Ищем существующую ставку
      const existingBid = await Bid.findOne({
        auctionId,
        userId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
      }).session(session);

      let bid: IBidDocument;
      let isNewBid = true;
      let previousAmount: number | undefined;

      if (existingBid) {
        isNewBid = false;
        previousAmount = existingBid.amount;

        if (amount <= existingBid.amount) {
          throw new Error(`Новая ставка должна быть выше текущей (${existingBid.amount})`);
        }

        const increment = amount - existingBid.amount;
        if (increment < auction.minBidIncrement) {
          throw new Error(`Минимальный шаг: ${auction.minBidIncrement}`);
        }

        // Блокируем только разницу
        await balanceService.lockAdditionalFunds(
          userId, increment, auctionId, existingBid._id as Types.ObjectId, session
        );

        existingBid.amount = amount;
        existingBid.updatedAt = new Date();
        await existingBid.save({ session });
        bid = existingBid;

        logger.info(`Ставка повышена: user=${userId}, ${previousAmount} -> ${amount}`);
      } else {
        const newBid = new Bid({
          auctionId,
          userId,
          amount,
          round: auction.currentRound,
          status: BidStatus.ACTIVE,
        });

        await balanceService.lockFunds(
          userId, amount, auctionId, newBid._id as Types.ObjectId, session
        );

        await newBid.save({ session });
        bid = newBid;

        logger.info(`Новая ставка: user=${userId}, amount=${amount}`);
      }

      await session.commitTransaction();

      // Инвалидируем кэш (лидерборд и минимальная ставка)
      redisService.invalidateAuctionCache(auctionId.toString()).catch(() => {});

      // Anti-sniping (вне транзакции)
      let roundExtended = false;
      try {
        roundExtended = await auctionService.extendRoundTime(auctionId);
      } catch (err) {
        logger.warn('Ошибка anti-snipe', { error: err });
      }

      return { bid, isNewBid, previousAmount, roundExtended };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async getLeaderboard(auctionId: Types.ObjectId, limit = 100): Promise<IBidDocument[]> {
    // Кэшируем лидерборд в Redis (горячие данные)
    return redisService.getCachedLeaderboard(
      auctionId.toString(),
      () => Bid.getLeaderboard(auctionId, limit)
    );
  }

  async getUserBid(auctionId: Types.ObjectId, userId: Types.ObjectId): Promise<IBidDocument | null> {
    return Bid.getUserActiveBid(auctionId, userId);
  }

  async getUserPosition(
    auctionId: Types.ObjectId,
    userId: Types.ObjectId
  ): Promise<{ position: number; totalBidders: number } | null> {
    const userBid = await this.getUserBid(auctionId, userId);
    if (!userBid) return null;

    const [higherCount, totalBidders] = await Promise.all([
      Bid.countDocuments({
        auctionId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
        $or: [
          { amount: { $gt: userBid.amount } },
          { amount: userBid.amount, createdAt: { $lt: userBid.createdAt } },
        ],
      }),
      Bid.countDocuments({
        auctionId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
      }),
    ]);

    return { position: higherCount + 1, totalBidders };
  }

  async getMinWinningBid(auctionId: Types.ObjectId): Promise<number | null> {
    // Кэшируем минимальную ставку в Redis
    return redisService.getCachedMinBid(auctionId.toString(), async () => {
      // Оптимизация: lean + select только нужные поля
      const auction = await Auction.findById(auctionId)
        .select('status currentRound rounds startingPrice')
        .lean();
      
      if (!auction || auction.status !== AuctionStatus.ACTIVE) return null;

      const currentRound = auction.rounds[auction.currentRound];
      if (!currentRound) return null;

      const itemsInRound = currentRound.itemsToDistribute;

      // EDGE CASE: Нет ставок — возвращаем стартовую цену
      const totalBids = await Bid.countDocuments({
        auctionId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
      });

      if (totalBids === 0) {
        return auction.startingPrice;
      }

      // EDGE CASE: Меньше участников чем товаров — все выигрывают
      if (totalBids < itemsInRound) {
        return auction.startingPrice;
      }

      // Находим пороговую ставку (N-ю по рангу)
      const thresholdBid = await Bid.findOne({
        auctionId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
      })
        .sort({ amount: -1, createdAt: 1 })
        .skip(itemsInRound - 1)
        .select('amount')
        .lean();

      return thresholdBid?.amount || auction.startingPrice;
    });
  }

  /**
   * Обработка победителей раунда.
   * Топ-N получают товар, остальные переносятся или получают возврат.
   * 
   * EDGE CASES:
   * - Нет участников — раунд просто завершается
   * - Меньше участников чем товаров — все выигрывают
   * - Равные ставки — выигрывает кто раньше поставил
   */
  async processRoundWinners(auctionId: Types.ObjectId): Promise<{
    winners: IBidDocument[];
    carriedOver: number;
    refunded: number;
  }> {
    const session = await mongoose.startSession();
    
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });

      const auction = await Auction.findById(auctionId).session(session);
      if (!auction) throw new Error('Аукцион не найден');

      const currentRound = auction.rounds[auction.currentRound];
      const itemsToDistribute = currentRound.itemsToDistribute;
      const isLastRound = auction.currentRound === auction.rounds.length - 1;

      // Все активные ставки отсортированы по amount DESC, createdAt ASC
      const allBids = await Bid.find({
        auctionId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
      })
        .sort({ amount: -1, createdAt: 1 })
        .session(session);

      const winners: IBidDocument[] = [];
      let carriedOver = 0;
      let refunded = 0;
      let itemNumber = auction.distributedItems + 1;

      // EDGE CASE: Нет участников — просто завершаем раунд
      if (allBids.length === 0) {
        logger.info(`Раунд ${auction.currentRound} завершён без участников`);
        
        await Auction.updateOne(
          { _id: auctionId },
          {
            $set: {
              [`rounds.${auction.currentRound}.status`]: 'completed',
              [`rounds.${auction.currentRound}.winnersCount`]: 0,
            },
          },
          { session }
        );

        await session.commitTransaction();
        return { winners: [], carriedOver: 0, refunded: 0 };
      }

      // EDGE CASE: Меньше участников чем товаров — все выигрывают
      const actualWinners = Math.min(allBids.length, itemsToDistribute);

      for (let i = 0; i < allBids.length; i++) {
        const bid = allBids[i];

        if (i < actualWinners) {
          bid.status = BidStatus.WON;
          bid.itemNumber = itemNumber++;

          await balanceService.chargeFunds(
            bid.userId, bid.amount, auctionId, bid._id as Types.ObjectId, session
          );
          await bid.save({ session });
          winners.push(bid);

          logger.info(`Победитель: user=${bid.userId}, item=#${bid.itemNumber}, amount=${bid.amount}`);
        } else if (isLastRound) {
          // Последний раунд — возвращаем деньги проигравшим
          bid.status = BidStatus.REFUNDED;
          await balanceService.refundFunds(
            bid.userId, bid.amount, auctionId, bid._id as Types.ObjectId, session
          );
          await bid.save({ session });
          refunded++;
        } else {
          // Переносим в следующий раунд
          bid.status = BidStatus.CARRIED_OVER;
          bid.round = auction.currentRound + 1;
          await bid.save({ session });
          carriedOver++;
        }
      }

      await Auction.updateOne(
        { _id: auctionId },
        {
          $set: {
            [`rounds.${auction.currentRound}.status`]: 'completed',
            [`rounds.${auction.currentRound}.winnersCount`]: winners.length,
          },
          $inc: { distributedItems: winners.length },
        },
        { session }
      );

      await session.commitTransaction();

      // Инвалидируем кэш после завершения раунда
      redisService.invalidateAuctionCache(auctionId.toString()).catch(() => {});

      logger.info(`Раунд ${auction.currentRound} завершён: winners=${winners.length}, carried=${carriedOver}, refunded=${refunded}`);
      return { winners, carriedOver, refunded };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async cancelAuctionBids(auctionId: Types.ObjectId): Promise<number> {
    const session = await mongoose.startSession();
    
    try {
      session.startTransaction();

      const activeBids = await Bid.find({
        auctionId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
      }).session(session);

      for (const bid of activeBids) {
        bid.status = BidStatus.CANCELLED;
        await balanceService.refundFunds(
          bid.userId, bid.amount, auctionId, bid._id as Types.ObjectId, session
        );
        await bid.save({ session });
      }

      await session.commitTransaction();
      return activeBids.length;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async getUserBidHistory(
    userId: Types.ObjectId,
    page = 1,
    limit = 20
  ): Promise<{ bids: IBidDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [bids, total] = await Promise.all([
      Bid.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('auctionId', 'title'),
      Bid.countDocuments({ userId }),
    ]);

    return { bids, total };
  }

  /**
   * Получить всех победителей аукциона (для показа после завершения).
   */
  async getAuctionWinners(auctionId: Types.ObjectId): Promise<IBidDocument[]> {
    return Bid.find({
      auctionId,
      status: BidStatus.WON,
    })
      .sort({ itemNumber: 1 })
      .populate('userId', 'username');
  }
}

export const bidService = new BidService();
