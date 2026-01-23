import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Redis сервис для кэширования и pub/sub.
 * Используется для:
 * - Кэширование лидерборда (горячие данные)
 * - Кэширование минимальной выигрышной ставки
 * - Rate limiting (опционально)
 */
class RedisService {
  private client: Redis | null = null;
  private subscriber: Redis | null = null;
  private isConnected = false;

  // TTL для разных типов кэша (в секундах) — оптимизировано для высокой нагрузки
  private readonly TTL = {
    LEADERBOARD: 1,      // Лидерборд — 1 секунда (real-time важнее)
    MIN_BID: 1,          // Минимальная ставка — 1 секунда
    AUCTION: 10,         // Данные аукциона — 10 секунд
    USER_POSITION: 1,    // Позиция пользователя — 1 секунда
  };

  async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      // Создаём клиент с отключенным auto-reconnect при ошибке
      this.client = new Redis(config.redis.uri, {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // Не переподключаемся автоматически
        lazyConnect: true,
        enableReadyCheck: false,
        reconnectOnError: () => false,
      });

      this.subscriber = new Redis(config.redis.uri, {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        lazyConnect: true,
        enableReadyCheck: false,
        reconnectOnError: () => false,
      });

      // Подавляем ошибки ДО подключения
      this.client.on('error', () => {}); // Тихо игнорируем
      this.subscriber.on('error', () => {});

      await this.client.connect();
      await this.subscriber.connect();

      this.isConnected = true;
      logger.info('Redis подключён');
    } catch (err: any) {
      logger.warn(`Redis недоступен (${err.message}), работаем без кэша`);
      // Очищаем клиенты чтобы не было утечек
      this.cleanup();
    }
  }

  private cleanup(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    this.isConnected = false;
  }

  async disconnect(): Promise<void> {
    try {
      if (this.client) await this.client.quit();
      if (this.subscriber) await this.subscriber.quit();
    } catch {
      // Игнорируем ошибки при отключении
    }
    this.client = null;
    this.subscriber = null;
    this.isConnected = false;
  }

  // === Кэширование ===

  /**
   * Получить из кэша с автоматическим fallback на функцию
   */
  async getOrSet<T>(
    key: string,
    fallback: () => Promise<T>,
    ttlSeconds: number
  ): Promise<T> {
    if (!this.client) return fallback();

    try {
      const cached = await this.client.get(key);
      if (cached) {
        return JSON.parse(cached);
      }

      const data = await fallback();
      // Сохраняем в фоне (не блокируем)
      this.client.setex(key, ttlSeconds, JSON.stringify(data)).catch(() => {});
      return data;
    } catch {
      return fallback();
    }
  }

  /**
   * Инвалидировать кэш по паттерну
   */
  async invalidate(pattern: string): Promise<void> {
    if (!this.client) return;

    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch (err) {
      logger.debug(`Ошибка инвалидации кэша: ${err}`);
    }
  }

  /**
   * Быстрое удаление конкретного ключа
   */
  async del(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.del(key).catch(() => {});
  }

  // === Ключи кэша ===

  leaderboardKey(auctionId: string): string {
    return `lb:${auctionId}`;
  }

  minBidKey(auctionId: string): string {
    return `minbid:${auctionId}`;
  }

  auctionKey(auctionId: string): string {
    return `auction:${auctionId}`;
  }

  userPositionKey(auctionId: string, userId: string): string {
    return `pos:${auctionId}:${userId}`;
  }

  // === Методы для аукционов ===

  /**
   * Кэшированный лидерборд
   */
  async getCachedLeaderboard<T>(
    auctionId: string,
    fallback: () => Promise<T>
  ): Promise<T> {
    return this.getOrSet(
      this.leaderboardKey(auctionId),
      fallback,
      this.TTL.LEADERBOARD
    );
  }

  /**
   * Кэшированная минимальная ставка
   */
  async getCachedMinBid(
    auctionId: string,
    fallback: () => Promise<number | null>
  ): Promise<number | null> {
    return this.getOrSet(
      this.minBidKey(auctionId),
      fallback,
      this.TTL.MIN_BID
    );
  }

  /**
   * Инвалидировать кэш аукциона (после ставки)
   */
  async invalidateAuctionCache(auctionId: string): Promise<void> {
    if (!this.client) return;
    
    const keys = [
      this.leaderboardKey(auctionId),
      this.minBidKey(auctionId),
    ];
    
    await this.client.del(...keys).catch(() => {});
  }

  // === Rate Limiting ===

  /**
   * Проверка rate limit (sliding window)
   */
  async checkRateLimit(
    key: string,
    maxRequests: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number }> {
    if (!this.client) return { allowed: true, remaining: maxRequests };

    try {
      const now = Date.now();
      const windowStart = now - windowSeconds * 1000;
      const fullKey = `rl:${key}`;

      // Используем sorted set для sliding window
      const multi = this.client.multi();
      multi.zremrangebyscore(fullKey, 0, windowStart);
      multi.zadd(fullKey, now, `${now}`);
      multi.zcard(fullKey);
      multi.expire(fullKey, windowSeconds);
      
      const results = await multi.exec();
      const count = results?.[2]?.[1] as number || 0;

      return {
        allowed: count <= maxRequests,
        remaining: Math.max(0, maxRequests - count),
      };
    } catch {
      return { allowed: true, remaining: maxRequests };
    }
  }

  // === Pub/Sub ===

  async publish(channel: string, message: unknown): Promise<void> {
    if (!this.client) return;
    await this.client.publish(channel, JSON.stringify(message)).catch(() => {});
  }

  async subscribe(channel: string, callback: (message: unknown) => void): Promise<void> {
    if (!this.subscriber) return;

    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch, msg) => {
      if (ch === channel) {
        try {
          callback(JSON.parse(msg));
        } catch {
          callback(msg);
        }
      }
    });
  }

  get connected(): boolean {
    return this.isConnected && this.client !== null;
  }
}

export const redisService = new RedisService();
