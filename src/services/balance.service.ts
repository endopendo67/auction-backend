import mongoose, { ClientSession, Types } from 'mongoose';
import { User, Transaction, TransactionType, IUserDocument } from '../models';
import { logger } from '../utils/logger';

/**
 * Сервис балансов.
 * Все операции атомарны и логируются в Transaction.
 */
export class BalanceService {

  async deposit(userId: Types.ObjectId, amount: number): Promise<IUserDocument> {
    if (amount <= 0) {
      throw new Error('Сумма депозита должна быть положительной');
    }

    const session = await mongoose.startSession();
    
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });

      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('Пользователь не найден');

      const balanceBefore = user.balance;
      const lockedBefore = user.lockedBalance;

      user.balance += amount;
      await user.save({ session });

      await Transaction.create([{
        userId,
        type: TransactionType.DEPOSIT,
        amount,
        balanceBefore,
        balanceAfter: user.balance,
        lockedBefore,
        lockedAfter: user.lockedBalance,
        description: `Пополнение на ${amount} звёзд`,
      }], { session });

      await session.commitTransaction();
      logger.info(`Депозит ${amount} для user=${userId}`);
      return user;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async lockFunds(
    userId: Types.ObjectId,
    amount: number,
    auctionId: Types.ObjectId,
    bidId: Types.ObjectId,
    session: ClientSession
  ): Promise<void> {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('Пользователь не найден');

    const available = user.balance - user.lockedBalance;
    if (available < amount) {
      throw new Error(`Недостаточно средств. Доступно: ${available}, требуется: ${amount}`);
    }

    const balanceBefore = user.balance;
    const lockedBefore = user.lockedBalance;

    // Атомарное обновление с проверкой
    const result = await User.updateOne(
      {
        _id: userId,
        $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, amount] }
      },
      { $inc: { lockedBalance: amount } },
      { session }
    );

    if (result.modifiedCount === 0) {
      throw new Error('Не удалось заблокировать средства (конкурентное изменение)');
    }

    await Transaction.create([{
      userId,
      type: TransactionType.BID_LOCK,
      amount,
      balanceBefore,
      balanceAfter: balanceBefore,
      lockedBefore,
      lockedAfter: lockedBefore + amount,
      auctionId,
      bidId,
      description: `Заблокировано ${amount} для ставки`,
    }], { session });
  }

  async lockAdditionalFunds(
    userId: Types.ObjectId,
    additionalAmount: number,
    auctionId: Types.ObjectId,
    bidId: Types.ObjectId,
    session: ClientSession
  ): Promise<void> {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('Пользователь не найден');

    const available = user.balance - user.lockedBalance;
    if (available < additionalAmount) {
      throw new Error(`Недостаточно средств для повышения. Доступно: ${available}`);
    }

    const balanceBefore = user.balance;
    const lockedBefore = user.lockedBalance;

    const result = await User.updateOne(
      {
        _id: userId,
        $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, additionalAmount] }
      },
      { $inc: { lockedBalance: additionalAmount } },
      { session }
    );

    if (result.modifiedCount === 0) {
      throw new Error('Не удалось заблокировать средства (конкурентное изменение)');
    }

    await Transaction.create([{
      userId,
      type: TransactionType.BID_INCREASE_LOCK,
      amount: additionalAmount,
      balanceBefore,
      balanceAfter: balanceBefore,
      lockedBefore,
      lockedAfter: lockedBefore + additionalAmount,
      auctionId,
      bidId,
      description: `Дополнительная блокировка ${additionalAmount}`,
    }], { session });
  }

  async chargeFunds(
    userId: Types.ObjectId,
    amount: number,
    auctionId: Types.ObjectId,
    bidId: Types.ObjectId,
    session: ClientSession
  ): Promise<void> {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('Пользователь не найден');

    if (user.lockedBalance < amount) {
      logger.error(`Несоответствие баланса у ${userId}`, {
        locked: user.lockedBalance,
        charge: amount,
      });
      throw new Error('Ошибка баланса: заблокировано меньше чем нужно списать');
    }

    const balanceBefore = user.balance;
    const lockedBefore = user.lockedBalance;

    // Атомарное списание
    const result = await User.updateOne(
      { _id: userId, lockedBalance: { $gte: amount } },
      { $inc: { balance: -amount, lockedBalance: -amount } },
      { session }
    );

    if (result.modifiedCount === 0) {
      throw new Error('Не удалось списать средства');
    }

    await Transaction.create([{
      userId,
      type: TransactionType.WIN_CHARGE,
      amount,
      balanceBefore,
      balanceAfter: balanceBefore - amount,
      lockedBefore,
      lockedAfter: lockedBefore - amount,
      auctionId,
      bidId,
      description: `Списание ${amount} за выигранный лот`,
    }], { session });
  }

  async refundFunds(
    userId: Types.ObjectId,
    amount: number,
    auctionId: Types.ObjectId,
    bidId: Types.ObjectId,
    session: ClientSession
  ): Promise<void> {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('Пользователь не найден');

    const balanceBefore = user.balance;
    const lockedBefore = user.lockedBalance;
    const actualRefund = Math.min(amount, user.lockedBalance);

    if (actualRefund > 0) {
      await User.updateOne(
        { _id: userId },
        { $inc: { lockedBalance: -actualRefund } },
        { session }
      );
    }

    await Transaction.create([{
      userId,
      type: TransactionType.REFUND,
      amount: actualRefund,
      balanceBefore,
      balanceAfter: balanceBefore,
      lockedBefore,
      lockedAfter: lockedBefore - actualRefund,
      auctionId,
      bidId,
      description: `Возврат ${actualRefund} звёзд`,
    }], { session });
  }

  async getBalance(userId: Types.ObjectId): Promise<{
    balance: number;
    lockedBalance: number;
    availableBalance: number;
  }> {
    const user = await User.findById(userId);
    if (!user) throw new Error('Пользователь не найден');

    return {
      balance: user.balance,
      lockedBalance: user.lockedBalance,
      availableBalance: user.balance - user.lockedBalance,
    };
  }
}

export const balanceService = new BalanceService();
