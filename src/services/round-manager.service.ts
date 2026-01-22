import { Auction, AuctionStatus } from '../models';
import { bidService } from './bid.service';
import { auctionService } from './auction.service';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

export interface RoundEvent {
  auctionId: string;
  roundNumber: number;
  type: 'round_started' | 'round_ending_soon' | 'round_ended' | 'auction_completed';
  data?: Record<string, unknown>;
}

/**
 * Сервис управления раундами аукционов.
 * Проверяет состояние раундов каждую секунду и обрабатывает переходы.
 */
class RoundManagerService extends EventEmitter {
  private checkInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  
  // Храним ID аукционов, для которых уже отправили предупреждение
  private warningSentFor: Set<string> = new Set();

  start(): void {
    if (this.checkInterval) return;

    logger.info('Запуск сервиса управления раундами');

    this.checkInterval = setInterval(async () => {
      if (this.isProcessing) return;

      this.isProcessing = true;
      try {
        await this.processActiveAuctions();
      } catch (err) {
        logger.error('Ошибка в round manager', { error: err });
      } finally {
        this.isProcessing = false;
      }
    }, 1000);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Сервис управления раундами остановлен');
    }
  }

  private async processActiveAuctions(): Promise<void> {
    const now = Date.now();

    // Обрабатываем активные аукционы
    const activeAuctions = await Auction.find({
      status: AuctionStatus.ACTIVE,
      'rounds.status': 'active',
    });

    for (const auction of activeAuctions) {
      const currentRound = auction.rounds[auction.currentRound];
      if (!currentRound || currentRound.status !== 'active') continue;

      const timeRemaining = currentRound.endTime.getTime() - now;

      // Предупреждение за 30 сек до конца (отправляем только один раз)
      if (timeRemaining > 0 && timeRemaining <= 30000) {
        const warningKey = `${auction.id}_${auction.currentRound}`;
        
        if (!this.warningSentFor.has(warningKey)) {
          this.warningSentFor.add(warningKey);
          this.emit('round_event', {
            auctionId: auction.id,
            roundNumber: auction.currentRound,
            type: 'round_ending_soon',
            data: { timeRemainingMs: timeRemaining },
          } as RoundEvent);
        }
      }

      // Раунд завершился - обрабатываем
      if (timeRemaining <= 0) {
        await this.handleRoundEnd(auction.id, auction.currentRound);
      }
    }

    // Запускаем аукционы, которые должны начаться
    await this.startPendingAuctions();
  }

  private async startPendingAuctions(): Promise<void> {
    const pendingAuctions = await Auction.find({
      status: AuctionStatus.PENDING,
      startTime: { $lte: new Date() },
    });

    for (const auction of pendingAuctions) {
      try {
        await auctionService.startAuction(auction._id);
        this.emit('round_event', {
          auctionId: auction.id,
          roundNumber: 0,
          type: 'round_started',
        } as RoundEvent);
      } catch (err) {
        logger.error(`Не удалось запустить аукцион ${auction.id}`, { error: err });
      }
    }
  }

  private async handleRoundEnd(auctionId: string, roundNumber: number): Promise<void> {
    logger.info(`Завершение раунда ${roundNumber} аукциона ${auctionId}`);

    // Очищаем флаг предупреждения для этого раунда
    this.warningSentFor.delete(`${auctionId}_${roundNumber}`);

    // Retry при WriteConflict (код 112)
    const MAX_RETRIES = 5;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await bidService.processRoundWinners(
          auctionId as unknown as import('mongoose').Types.ObjectId
        );

        this.emit('round_event', {
          auctionId,
          roundNumber,
          type: 'round_ended',
          data: {
            winnersCount: result.winners.length,
            carriedOver: result.carriedOver,
            refunded: result.refunded,
          },
        } as RoundEvent);

        const updated = await auctionService.advanceToNextRound(
          auctionId as unknown as import('mongoose').Types.ObjectId
        );

        if (!updated) return;

        if (updated.status === AuctionStatus.COMPLETED) {
          this.emit('round_event', {
            auctionId,
            roundNumber: updated.rounds.length - 1,
            type: 'auction_completed',
            data: { totalDistributed: updated.distributedItems },
          } as RoundEvent);
        } else {
          this.emit('round_event', {
            auctionId,
            roundNumber: updated.currentRound,
            type: 'round_started',
          } as RoundEvent);
        }
        
        return; // Успех — выходим
      } catch (err: any) {
        lastError = err;
        
        // WriteConflict — ждём и повторяем
        if (err.code === 112 || err.message?.includes('WriteConflict')) {
          const delay = Math.pow(2, attempt) * 100 + Math.random() * 100;
          logger.warn(`WriteConflict при завершении раунда, повтор ${attempt + 1}/${MAX_RETRIES}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        
        // Другая ошибка — не повторяем
        break;
      }
    }

    logger.error(`Ошибка при завершении раунда аукциона ${auctionId}`, { error: lastError });
  }

  // Для тестирования
  async forceProcessRound(auctionId: string): Promise<void> {
    const auction = await Auction.findById(auctionId);
    if (auction) {
      await this.handleRoundEnd(auctionId, auction.currentRound);
    }
  }
}

export const roundManagerService = new RoundManagerService();
