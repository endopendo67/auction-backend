import { Types } from 'mongoose';
import { User, IUserDocument, Transaction } from '../models';
import { balanceService } from './balance.service';
import { logger } from '../utils/logger';

export class UserService {
  
  async createUser(username: string, initialBalance = 0): Promise<IUserDocument> {
    const existing = await User.findByUsername(username);
    if (existing) {
      throw new Error('Имя пользователя занято');
    }

    const user = new User({
      username,
      balance: 0,
      lockedBalance: 0,
    });
    await user.save();

    // Начисляем начальный баланс если указан
    if (initialBalance > 0) {
      await balanceService.deposit(user._id as Types.ObjectId, initialBalance);
      user.balance = initialBalance;
    }

    logger.info(`Создан пользователь: ${username}`);
    return user;
  }

  async getUserById(userId: Types.ObjectId): Promise<IUserDocument | null> {
    return User.findById(userId);
  }

  async getUserByUsername(username: string): Promise<IUserDocument | null> {
    return User.findByUsername(username);
  }

  async getOrCreateUser(username: string): Promise<IUserDocument> {
    let user = await User.findByUsername(username);
    if (!user) {
      user = await this.createUser(username);
    }
    return user;
  }

  async getUserBalance(userId: Types.ObjectId) {
    return balanceService.getBalance(userId);
  }

  async getUserTransactions(
    userId: Types.ObjectId,
    page = 1,
    limit = 20
  ): Promise<{ transactions: typeof Transaction[]; total: number }> {
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments({ userId }),
    ]);

    return { transactions: transactions as any, total };
  }

  async deposit(userId: Types.ObjectId, amount: number): Promise<IUserDocument> {
    return balanceService.deposit(userId, amount);
  }

  async getAllUsers(page = 1, limit = 50): Promise<{ users: IUserDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      User.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(),
    ]);

    return { users, total };
  }
}

export const userService = new UserService();
