import http from 'http';
import { createApp } from './app';
import { connectDatabase } from './db/connection';
import { config } from './config';
import { logger } from './utils/logger';
import { socketHandler } from './websocket/socket-handler';
import { roundManagerService, redisService } from './services';

async function bootstrap(): Promise<void> {
  try {
    // Подключение к базам данных
    await connectDatabase();
    await redisService.connect(); // Redis (опционально, работает и без него)

    // Create Express app
    const app = createApp();

    // Create HTTP server
    const server = http.createServer(app);

    // Initialize WebSocket
    socketHandler.initialize(server);

    // Start round manager
    roundManagerService.start();

    // Start server
    server.listen(config.server.port, () => {
      logger.info(`Server running on port ${config.server.port}`);
      logger.info(`Environment: ${config.server.env}`);
      logger.info(`API: http://localhost:${config.server.port}/api`);
      logger.info(`Frontend: http://localhost:${config.server.port}`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      roundManagerService.stop();
      await redisService.disconnect();
      
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });

      // Force close after 10 seconds
      setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
