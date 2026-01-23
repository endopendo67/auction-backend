import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { userService, bidService } from '../services';
import { asyncHandler, createError } from '../middleware/error-handler';

const createUserSchema = z.object({
  username: z.string().min(3).max(32).trim(),
  initialBalance: z.number().min(0).optional(),
});

const depositSchema = z.object({
  amount: z.number().positive(),
});

export const userController = {
  // Создать пользователя
  create: asyncHandler(async (req: Request, res: Response) => {
    const { username, initialBalance } = createUserSchema.parse(req.body);
    
    const user = await userService.createUser(username, initialBalance);
    
    res.status(201).json({
      success: true,
      data: user.toJSON(),
    });
  }),

  // Получить по ID
  getById: asyncHandler(async (req: Request, res: Response) => {
    const userId = new Types.ObjectId(req.params.id);
    const user = await userService.getUserById(userId);
    
    if (!user) {
      throw createError('Пользователь не найден', 404, 'USER_NOT_FOUND');
    }
    
    res.json({
      success: true,
      data: user.toJSON(),
    });
  }),

  // Получить по имени
  getByUsername: asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const user = await userService.getUserByUsername(username);
    
    if (!user) {
      throw createError('Пользователь не найден', 404, 'USER_NOT_FOUND');
    }
    
    res.json({
      success: true,
      data: user.toJSON(),
    });
  }),

  // Получить или создать (для демо)
  getOrCreate: asyncHandler(async (req: Request, res: Response) => {
    const { username, initialBalance } = createUserSchema.parse(req.body);
    
    let user = await userService.getUserByUsername(username);
    let created = false;
    
    if (!user) {
      user = await userService.createUser(username, initialBalance);
      created = true;
    }
    
    res.status(created ? 201 : 200).json({
      success: true,
      data: user.toJSON(),
      created,
    });
  }),

  // Получить баланс
  getBalance: asyncHandler(async (req: Request, res: Response) => {
    const userId = new Types.ObjectId(req.params.id);
    const balance = await userService.getUserBalance(userId);
    
    res.json({
      success: true,
      data: balance,
    });
  }),

  // Пополнение счёта
  deposit: asyncHandler(async (req: Request, res: Response) => {
    const userId = new Types.ObjectId(req.params.id);
    const { amount } = depositSchema.parse(req.body);
    
    const user = await userService.deposit(userId, amount);
    
    res.json({
      success: true,
      data: {
        balance: user.balance,
        lockedBalance: user.lockedBalance,
        availableBalance: user.balance - user.lockedBalance,
      },
    });
  }),

  // История транзакций
  getTransactions: asyncHandler(async (req: Request, res: Response) => {
    const userId = new Types.ObjectId(req.params.id);
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    
    const result = await userService.getUserTransactions(userId, page, limit);
    
    res.json({
      success: true,
      data: result.transactions,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.ceil(result.total / limit),
      },
    });
  }),

  // История ставок
  getBidHistory: asyncHandler(async (req: Request, res: Response) => {
    const userId = new Types.ObjectId(req.params.id);
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    
    const result = await bidService.getUserBidHistory(userId, page, limit);
    
    res.json({
      success: true,
      data: result.bids,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.ceil(result.total / limit),
      },
    });
  }),

  // Выигранные предметы
  getWonItems: asyncHandler(async (req: Request, res: Response) => {
    const userId = new Types.ObjectId(req.params.id);
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    
    const result = await bidService.getUserWonItems(userId, page, limit);
    
    res.json({
      success: true,
      data: result.items,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.ceil(result.total / limit),
      },
    });
  }),

  // Список пользователей
  list: asyncHandler(async (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    
    const result = await userService.getAllUsers(page, limit);
    
    res.json({
      success: true,
      data: result.users,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.ceil(result.total / limit),
      },
    });
  }),
};
