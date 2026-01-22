import { Types } from 'mongoose';
import { User, Transaction, TransactionType, IUserDocument } from '../models';
import { logger } from '../utils/logger';

// Лимиты для защиты от edge cases
const LIMITS = {
  MAX_DEPOSIT: 1_000_000_000, // 1 млрд
  MAX_BALANCE: 10_000_000_000, // 10 млрд
} as const;

/**
 * Сервис балансов.
 * ВСЕ ОПЕРАЦИИ АТОМАРНЫ — без транзакций, без WriteConflict.
 * Каждая операция — один атомарный findOneAndUpdate с условиями.
 */
export class BalanceService {

  /**
   * Пополнение баланса — атомарно
   */
  async deposit(userId: Types.ObjectId, amount: number): Promise<IUserDocument> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Сумма депозита должна быть положительным целым числом');
    }
    if (amount > LIMITS.MAX_DEPOSIT) {
      throw new Error(`Максимальный депозит: ${LIMITS.MAX_DEPOSIT}`);
    }

    // АТОМАРНО: проверяем лимит и обновляем в одном запросе
    const user = await User.findOneAndUpdate(
      {
        _id: userId,
        balance: { $lte: LIMITS.MAX_BALANCE - amount }
      },
      { $inc: { balance: amount } },
      { new: true }
    );

    if (!user) {
      // Проверяем почему не получилось
      const existingUser = await User.findById(userId).lean();
      if (!existingUser) throw new Error('Пользователь не найден');
      throw new Error(`Баланс превысит максимум (${LIMITS.MAX_BALANCE})`);
    }

    // Логируем транзакцию асинхронно
    Transaction.create({
      userId,
      type: TransactionType.DEPOSIT,
      amount,
      balanceBefore: user.balance - amount,
      balanceAfter: user.balance,
      lockedBefore: user.lockedBalance,
      lockedAfter: user.lockedBalance,
      description: `Пополнение на ${amount} звёзд`,
    }).catch(err => logger.warn('Ошибка записи транзакции', { error: err }));

    logger.info(`Депозит ${amount} для user=${userId}`);
    return user;
  }

  /**
   * Блокировка средств — атомарно (используется в bid.service)
   */
  async lockFundsAtomic(
    userId: Types.ObjectId,
    amount: number,
    auctionId?: Types.ObjectId,
    bidId?: Types.ObjectId
  ): Promise<IUserDocument | null> {
    const user = await User.findOneAndUpdate(
      {
        _id: userId,
        $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, amount] }
      },
      { $inc: { lockedBalance: amount } },
      { new: true }
    );

    if (user && auctionId) {
      // Логируем асинхронно
      Transaction.create({
        userId,
        type: TransactionType.BID_LOCK,
        amount,
        balanceBefore: user.balance,
        balanceAfter: user.balance,
        lockedBefore: user.lockedBalance - amount,
        lockedAfter: user.lockedBalance,
        auctionId,
        bidId,
        description: `Заблокировано ${amount} для ставки`,
      }).catch(() => {});
    }

    return user;
  }

  /**
   * Разблокировка средств — атомарно (компенсация при ошибке)
   */
  async unlockFundsAtomic(userId: Types.ObjectId, amount: number): Promise<void> {
    await User.updateOne(
      { _id: userId, lockedBalance: { $gte: amount } },
      { $inc: { lockedBalance: -amount } }
    );
  }

  /**
   * Списание средств победителю — атомарно (bulk операция в bid.service)
   */
  async chargeFundsAtomic(
    userId: Types.ObjectId,
    amount: number,
    auctionId?: Types.ObjectId
  ): Promise<boolean> {
    const result = await User.updateOne(
      { _id: userId, lockedBalance: { $gte: amount } },
      { $inc: { balance: -amount, lockedBalance: -amount } }
    );

    if (result.modifiedCount > 0 && auctionId) {
      Transaction.create({
        userId,
        type: TransactionType.WIN_CHARGE,
        amount,
        auctionId,
        description: `Списание ${amount} за выигранный лот`,
      }).catch(() => {});
    }

    return result.modifiedCount > 0;
  }

  /**
   * Возврат средств проигравшему — атомарно
   */
  async refundFundsAtomic(
    userId: Types.ObjectId,
    amount: number,
    auctionId?: Types.ObjectId
  ): Promise<boolean> {
    const result = await User.updateOne(
      { _id: userId, lockedBalance: { $gte: amount } },
      { $inc: { lockedBalance: -amount } }
    );

    if (result.modifiedCount > 0 && auctionId) {
      Transaction.create({
        userId,
        type: TransactionType.REFUND,
        amount,
        auctionId,
        description: `Возврат ${amount} звёзд`,
      }).catch(() => {});
    }

    return result.modifiedCount > 0;
  }

  async getBalance(userId: Types.ObjectId): Promise<{
    balance: number;
    lockedBalance: number;
    availableBalance: number;
  }> {
    const user = await User.findById(userId)
      .select('balance lockedBalance')
      .lean();
    
    if (!user) throw new Error('Пользователь не найден');

    return {
      balance: user.balance,
      lockedBalance: user.lockedBalance,
      availableBalance: user.balance - user.lockedBalance,
    };
  }
}

export const balanceService = new BalanceService();
