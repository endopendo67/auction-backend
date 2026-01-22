import { Request, Response } from 'express';
import { z } from 'zod';
import { userService } from '../services';
import { asyncHandler, createError } from '../middleware/error-handler';
import { setSessionCookie, clearSessionCookie } from '../middleware/auth';

const loginSchema = z.object({
  username: z.string().min(3).max(32).trim(),
  initialBalance: z.number().min(0).optional(),
});

export const authController = {
  /**
   * Вход / регистрация
   * POST /api/auth/login
   */
  login: asyncHandler(async (req: Request, res: Response) => {
    const { username, initialBalance = 10000 } = loginSchema.parse(req.body);

    let user = await userService.getUserByUsername(username);
    let isNew = false;

    if (!user) {
      user = await userService.createUser(username, initialBalance);
      isNew = true;
    }

    setSessionCookie(res, user.id);

    const balance = await userService.getUserBalance(user._id);

    res.json({
      success: true,
      data: {
        user: user.toJSON(),
        balance,
        isNewUser: isNew,
      },
    });
  }),

  /**
   * Выход
   * POST /api/auth/logout
   */
  logout: asyncHandler(async (req: Request, res: Response) => {
    clearSessionCookie(res);

    res.json({
      success: true,
      data: { message: 'Logged out' },
    });
  }),

  /**
   * Получить текущего пользователя
   * GET /api/auth/me
   */
  me: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) {
      res.json({
        success: true,
        data: null,
      });
      return;
    }

    const balance = await userService.getUserBalance(req.user._id);

    res.json({
      success: true,
      data: {
        user: req.user.toJSON(),
        balance,
      },
    });
  }),
};
