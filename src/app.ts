import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'path';
import { apiRoutes } from './routes';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { authMiddleware } from './middleware/auth';

export function createApp(): Application {
  const app = express();

  // Отключаем ETag для скорости
  app.set('etag', false);
  app.set('x-powered-by', false);

  // Минимальная безопасность (отключаем лишнее для скорости)
  app.use(helmet({ 
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }));

  // CORS
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // Сжатие только для больших ответов
  app.use(compression({ threshold: 1024 }));

  // Парсинг — оптимизированный
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false, limit: '512kb' }));
  app.use(cookieParser());

  // Авторизация
  app.use(authMiddleware);

  // Статика без кэширования (для отладки)
  app.use(express.static(path.join(__dirname, '../public'), {
    maxAge: 0,
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    },
  }));

  // API
  app.use('/api', apiRoutes);

  // SPA fallback
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  // Обработка ошибок
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
