import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'path';
import { apiRoutes } from './routes';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { authMiddleware } from './middleware/auth';
import { logger } from './utils/logger';

export function createApp(): Application {
  const app = express();

  // Безопасность
  app.use(helmet({ contentSecurityPolicy: false }));

  // CORS
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // Сжатие
  app.use(compression());

  // Парсинг
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  // Авторизация
  app.use(authMiddleware);

  // Логирование запросов
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (!req.path.includes('/health')) {
        logger.debug(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      }
    });
    next();
  });

  // API routes
  app.use('/api', apiRoutes);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Обработка ошибок
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
