import { Types } from 'mongoose';
import { Bid, IBidDocument, BidStatus, Auction, AuctionStatus, User, Transaction, TransactionType } from '../models';
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
 * ПОЛНОСТЬЮ АТОМАРНЫЕ ОПЕРАЦИИ — без транзакций, без WriteConflict.
 * Каждая операция — один атомарный запрос к MongoDB.
 */
export class BidService {
  /**
   * Размещение ставки — полностью атомарно, без транзакций.
   */
  async placeBid(
    auctionId: Types.ObjectId,
    userId: Types.ObjectId,
    amount: number
  ): Promise<PlaceBidResult> {
    // Rate limiting (настраивается, по умолчанию OFF)
    const { rateLimitRequests, rateLimitWindowSec } = config.bid;
    if (rateLimitRequests > 0) {
      const rateLimit = await redisService.checkRateLimit(
        `bid:${userId}`,
        rateLimitRequests,
        rateLimitWindowSec
      );
      if (!rateLimit.allowed) {
        throw new Error('Слишком много запросов. Подождите немного');
      }
    }

    // === Валидация суммы ===
    if (!Number.isInteger(amount) || amount < 1) {
      throw new Error('Сумма ставки должна быть положительным целым числом');
  }
    if (amount > LIMITS.MAX_BID_AMOUNT) {
      throw new Error(`Максимальная ставка: ${LIMITS.MAX_BID_AMOUNT}`);
    }

    // === Параллельная загрузка аукциона, существующей ставки, минимальной победной и статуса победы ===
    const [auction, existingBid, minWinningBid, alreadyWon] = await Promise.all([
      Auction.findById(auctionId)
        .select('status currentRound rounds startingPrice minBidIncrement')
        .lean(),
      Bid.findOne({
        auctionId,
        userId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
      })
        .select('_id amount')
        .lean(),
      this.getMinWinningBid(auctionId),
      Bid.exists({ auctionId, userId, status: BidStatus.WON }),
    ]);

    // Проверка: уже выиграл в этом аукционе
    if (alreadyWon) {
      throw new Error('Вы уже выиграли предмет в этом аукционе');
    }

    if (!auction) throw new Error('Аукцион не найден');
    if (auction.status !== AuctionStatus.ACTIVE) {
      throw new Error(`Аукцион не активен`);
    }

    const currentRound = auction.rounds[auction.currentRound];
    if (!currentRound || currentRound.status !== 'active') {
      throw new Error('Нет активного раунда');
    }

    // EDGE CASE: Ставка на границе времени
    const timeToEnd = new Date(currentRound.endTime).getTime() - Date.now();
    if (timeToEnd <= LIMITS.MIN_TIME_BUFFER_MS) {
      throw new Error('Раунд завершается');
    }

    if (amount < auction.startingPrice) {
      throw new Error(`Минимальная ставка: ${auction.startingPrice}`);
    }

    // Проверка: ставка должна быть >= минимальной победной
    if (minWinningBid && amount < minWinningBid) {
      throw new Error(`Новая ставка должна быть выше текущей (${minWinningBid})`);
    }

    let result: PlaceBidResult;

    let bidResult: { bid: IBidDocument; isNewBid: boolean; previousAmount?: number };

      if (existingBid) {
      // === ПОВЫШЕНИЕ СТАВКИ ===
      bidResult = await this.increaseBid(
        auctionId, userId, amount, existingBid, auction.minBidIncrement
      );
      } else {
      // === НОВАЯ СТАВКА ===
      bidResult = await this.createNewBid(auctionId, userId, amount, auction.currentRound);
    }

    // Инвалидируем кэш
    redisService.invalidateAuctionCache(auctionId.toString()).catch(() => {});

    // Anti-sniping (отдельная атомарная операция)
      let roundExtended = false;
      try {
        roundExtended = await auctionService.extendRoundTime(auctionId);
      } catch (err) {
        logger.warn('Ошибка anti-snipe', { error: err });
      }

    return { ...bidResult, roundExtended };
  }

  /**
   * Новая ставка — атомарная блокировка + создание
   */
  private async createNewBid(
    auctionId: Types.ObjectId,
    userId: Types.ObjectId,
    amount: number,
    round: number
  ): Promise<{ bid: IBidDocument; isNewBid: boolean }> {
    // 1. АТОМАРНО блокируем средства (с проверкой баланса в запросе)
    const lockResult = await User.findOneAndUpdate(
      {
        _id: userId,
        $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, amount] }
      },
      { 
        $inc: { lockedBalance: amount },
      },
      { new: true }
    );

    if (!lockResult) {
      // Проверяем почему не получилось
      const user = await User.findById(userId).lean();
      if (!user) throw new Error('Пользователь не найден');
      const available = user.balance - user.lockedBalance;
      throw new Error(`Недостаточно средств. Доступно: ${available}, требуется: ${amount}`);
    }

    // 2. Создаём ставку
    let bid: IBidDocument;
    try {
      bid = await Bid.create({
        auctionId,
        userId,
        amount,
        round,
        status: BidStatus.ACTIVE,
      });
    } catch (err) {
      // Компенсация: разблокируем средства
      await User.updateOne(
        { _id: userId },
        { $inc: { lockedBalance: -amount } }
      );
      throw err;
    }

    // 3. Логируем транзакцию (асинхронно, не блокируем)
    Transaction.create({
      userId,
      type: TransactionType.BID_LOCK,
      amount,
      balanceBefore: lockResult.balance,
      balanceAfter: lockResult.balance,
      lockedBefore: lockResult.lockedBalance - amount,
      lockedAfter: lockResult.lockedBalance,
      auctionId,
      bidId: bid._id,
      description: `Заблокировано ${amount} для ставки`,
    }).catch(err => logger.warn('Ошибка записи транзакции', { error: err }));

    logger.info(`Новая ставка: user=${userId}, amount=${amount}`);
    return { bid, isNewBid: true };
  }

  /**
   * Повышение ставки — атомарная доблокировка + обновление
   */
  private async increaseBid(
    auctionId: Types.ObjectId,
    userId: Types.ObjectId,
    newAmount: number,
    existingBid: any,
    minIncrement: number
  ): Promise<{ bid: IBidDocument; isNewBid: boolean; previousAmount: number }> {
    const previousAmount = existingBid.amount;

    if (newAmount <= previousAmount) {
      throw new Error(`Новая ставка должна быть выше текущей (${previousAmount})`);
    }

    const increment = newAmount - previousAmount;
    if (increment < minIncrement) {
      throw new Error(`Минимальный шаг: ${minIncrement}`);
    }

    // 1. АТОМАРНО блокируем дополнительные средства
    const lockResult = await User.findOneAndUpdate(
      {
        _id: userId,
        $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, increment] }
      },
      { 
        $inc: { lockedBalance: increment },
      },
      { new: true }
    );

    if (!lockResult) {
      const user = await User.findById(userId).lean();
      if (!user) throw new Error('Пользователь не найден');
      const available = user.balance - user.lockedBalance;
      throw new Error(`Недостаточно средств. Доступно: ${available}, требуется: ${increment}`);
    }

    // 2. АТОМАРНО обновляем ставку
    const updatedBid = await Bid.findOneAndUpdate(
      { 
        _id: existingBid._id,
        amount: previousAmount, // Optimistic lock: проверяем что сумма не изменилась
      },
      { 
        $set: { amount: newAmount, updatedAt: new Date() }
      },
      { new: true }
    );

    if (!updatedBid) {
      // Компенсация: разблокируем средства
      await User.updateOne(
        { _id: userId },
        { $inc: { lockedBalance: -increment } }
      );
      throw new Error('Ставка была изменена другим запросом, попробуйте снова');
    }

    // 3. Логируем транзакцию
    Transaction.create({
      userId,
      type: TransactionType.BID_LOCK,
      amount: increment,
      balanceBefore: lockResult.balance,
      balanceAfter: lockResult.balance,
      lockedBefore: lockResult.lockedBalance - increment,
      lockedAfter: lockResult.lockedBalance,
      auctionId,
      bidId: existingBid._id,
      description: `Доблокировано ${increment} для повышения ставки`,
    }).catch(err => logger.warn('Ошибка записи транзакции', { error: err }));

    logger.info(`Ставка повышена: user=${userId}, ${previousAmount} -> ${newAmount}`);
    return { bid: updatedBid, isNewBid: false, previousAmount };
  }

  async getLeaderboard(auctionId: Types.ObjectId, limit = 100): Promise<IBidDocument[]> {
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
    return redisService.getCachedMinBid(auctionId.toString(), async () => {
      const auction = await Auction.findById(auctionId)
        .select('currentRound rounds status')
        .lean();
      
    if (!auction || auction.status !== AuctionStatus.ACTIVE) return null;

    const currentRound = auction.rounds[auction.currentRound];
    if (!currentRound) return null;

    const itemsInRound = currentRound.itemsToDistribute;

      const bids = await Bid.find({
      auctionId,
      status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
    })
      .sort({ amount: -1, createdAt: 1 })
        .limit(itemsInRound)
        .select('amount')
        .lean();

      if (bids.length < itemsInRound) return null;
      return bids[bids.length - 1]?.amount || null;
    });
  }

  /**
   * Обработка победителей раунда — BATCH операции для скорости
   */
  async processRoundWinners(auctionId: Types.ObjectId): Promise<{
    winners: Types.ObjectId[];
    carriedOver: number;
    refunded: number;
  }> {
    const auction = await Auction.findById(auctionId);
      if (!auction) throw new Error('Аукцион не найден');

      const currentRound = auction.rounds[auction.currentRound];
    if (!currentRound) throw new Error('Нет текущего раунда');

      const itemsToDistribute = currentRound.itemsToDistribute;
    const isLastRound = auction.currentRound >= auction.rounds.length - 1;

    // Получаем все активные ставки отсортированные
      const allBids = await Bid.find({
        auctionId,
        status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
    }).sort({ amount: -1, createdAt: 1 });

    // Получаем список уже выигравших пользователей в этом аукционе
    const previousWinners = await Bid.distinct('userId', {
      auctionId,
      status: BidStatus.WON,
    });
    const previousWinnersSet = new Set(previousWinners.map(id => id.toString()));

    const winners: Types.ObjectId[] = [];
    const winnersData: Array<{ oduserId: Types.ObjectId; amount: number; itemNumber: number }> = [];
      let carriedOver = 0;
      let refunded = 0;
    let winnersSelected = 0;

    // Batch операции для User
    const userUpdates: Array<{ oduserId: Types.ObjectId; balanceDelta: number; lockedDelta: number }> = [];
    const bidUpdates: Array<{ id: Types.ObjectId; status: BidStatus; itemNumber?: number }> = [];

      for (let i = 0; i < allBids.length; i++) {
        const bid = allBids[i];
      
      // Пропускаем уже выигравших в предыдущих раундах
      if (previousWinnersSet.has(bid.userId.toString())) {
        // Возвращаем деньги победителям прошлых раундов (их ставка уже неактуальна)
        userUpdates.push({
          oduserId: bid.userId,
          balanceDelta: 0,
          lockedDelta: -bid.amount,
        });
        bidUpdates.push({ id: bid._id as Types.ObjectId, status: BidStatus.REFUNDED });
        refunded++;
        continue;
      }

      const isWinner = winnersSelected < itemsToDistribute;

      if (isWinner) {
        const itemNumber = auction.distributedItems + winners.length + 1;
        winners.push(bid.userId);
        winnersData.push({ oduserId: bid.userId, amount: bid.amount, itemNumber });
        winnersSelected++;
        
        // Победитель: списываем balance и lockedBalance
        userUpdates.push({
          oduserId: bid.userId,
          balanceDelta: -bid.amount,
          lockedDelta: -bid.amount,
        });
        bidUpdates.push({ id: bid._id as Types.ObjectId, status: BidStatus.WON, itemNumber });

        logger.info(`Победитель: user=${bid.userId}, item=#${itemNumber}, amount=${bid.amount}`);
        } else if (isLastRound) {
        // Последний раунд — возврат проигравшим
        userUpdates.push({
          oduserId: bid.userId,
          balanceDelta: 0,
          lockedDelta: -bid.amount,
        });
        bidUpdates.push({ id: bid._id as Types.ObjectId, status: BidStatus.REFUNDED });
          refunded++;
        } else {
        // Не последний раунд — переносим в следующий
        bidUpdates.push({ id: bid._id as Types.ObjectId, status: BidStatus.CARRIED_OVER });
          carriedOver++;
        }
      }

    // Выполняем batch обновления User
    const userBulkOps = userUpdates.map(u => ({
      updateOne: {
        filter: { _id: u.oduserId },
        update: { $inc: { balance: u.balanceDelta, lockedBalance: u.lockedDelta } },
      }
    }));
    
    if (userBulkOps.length > 0) {
      await User.bulkWrite(userBulkOps, { ordered: false });
    }

    // Выполняем batch обновления Bid
    const bidBulkOps = bidUpdates.map(b => ({
      updateOne: {
        filter: { _id: b.id },
        update: { 
          $set: b.itemNumber 
            ? { status: b.status, itemNumber: b.itemNumber }
            : { status: b.status }
        },
      }
    }));

    if (bidBulkOps.length > 0) {
      await Bid.bulkWrite(bidBulkOps, { ordered: false });
    }

    // Обновляем счётчик распределённых предметов
    await Auction.updateOne(
      { _id: auctionId },
      { $inc: { distributedItems: winners.length } }
    );

    // Логируем транзакции асинхронно
    this.logWinnerTransactions(winnersData, auctionId).catch(() => {});

      return { winners, carriedOver, refunded };
  }

  private async logWinnerTransactions(
    winners: Array<{ oduserId: Types.ObjectId; amount: number; itemNumber: number }>,
    auctionId: Types.ObjectId
  ): Promise<void> {
    const transactions = winners.map(w => ({
      userId: w.oduserId,
      type: TransactionType.WIN_CHARGE,
      amount: w.amount,
        auctionId,
      description: `Выигрыш предмета #${w.itemNumber}`,
    }));

    if (transactions.length > 0) {
      await Transaction.insertMany(transactions, { ordered: false }).catch(() => {});
    }
  }

  async getAuctionWinners(auctionId: Types.ObjectId): Promise<any[]> {
    return Bid.find({
      auctionId,
      status: BidStatus.WON,
    })
      .sort({ itemNumber: 1 })
      .populate('userId', 'username')
      .lean();
    }

  /**
   * История ставок пользователя с пагинацией
   */
  async getUserBidHistory(
    userId: Types.ObjectId,
    page: number = 1,
    limit: number = 20
  ): Promise<{ bids: any[]; total: number }> {
    const skip = (page - 1) * limit;

    const [bids, total] = await Promise.all([
      Bid.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('auctionId', 'title status')
        .lean(),
      Bid.countDocuments({ userId }),
    ]);

    return { bids, total };
  }

  /**
   * Выигранные предметы пользователя
   */
  async getUserWonItems(
    userId: Types.ObjectId,
    page: number = 1,
    limit: number = 20
  ): Promise<{ items: any[]; total: number }> {
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Bid.find({ userId, status: BidStatus.WON })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('auctionId', 'title')
        .lean(),
      Bid.countDocuments({ userId, status: BidStatus.WON }),
    ]);

    return { items, total };
  }
}

export const bidService = new BidService();
