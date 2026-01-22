import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { User, IUserDocument } from '../models';

const COOKIE_NAME = 'auction_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 дней

declare global {
  namespace Express {
    interface Request {
      user?: IUserDocument;
      userId?: Types.ObjectId;
    }
  }
}

/**
 * Middleware для проверки авторизации.
 * Читает userId из куки и загружает пользователя.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.cookies?.[COOKIE_NAME];
    
    if (userId && Types.ObjectId.isValid(userId)) {
      const user = await User.findById(userId);
      if (user) {
        req.user = user;
        req.userId = user._id as Types.ObjectId;
      }
    }
  } catch (err) {
    // Игнорируем ошибки - просто не будет авторизации
  }
  
  next();
}

/**
 * Middleware для защищённых роутов.
 * Требует авторизацию.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: { message: 'Требуется авторизация', code: 'UNAUTHORIZED' },
    });
    return;
  }
  next();
}

/**
 * Устанавливает сессионную куку.
 */
export function setSessionCookie(res: Response, userId: string): void {
  // COOKIE_SECURE=false позволяет работать без HTTPS (для локального тестирования)
  const isSecure = process.env.COOKIE_SECURE === 'false' 
    ? false 
    : process.env.NODE_ENV === 'production';
  
  res.cookie(COOKIE_NAME, userId, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * Удаляет сессионную куку.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export { COOKIE_NAME, COOKIE_MAX_AGE };
