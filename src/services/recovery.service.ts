import { Auction, AuctionStatus, Bid, BidStatus } from '../models';
import { logger } from '../utils/logger';

/**
 * Сервис восстановления состояния после перезапуска сервера.
 * Проверяет целостность данных и восстанавливает активные аукционы.
 */
class RecoveryService {
  /**
   * Основной метод восстановления — вызывается при старте сервера
   */
  async recover(): Promise<void> {
    logger.info('Запуск процесса восстановления...');
    
    try {
      // 1. Восстановление активных аукционов с истёкшими раундами
      await this.recoverExpiredRounds();
      
      // 2. Проверка целостности frozen balances
      await this.verifyFrozenBalances();
      
      logger.info('Восстановление завершено');
    } catch (err) {
      logger.error('Ошибка восстановления:', err);
    }
  }

  /**
   * Находит активные аукционы с истёкшими раундами
   * и помечает их для обработки RoundManager
   */
  private async recoverExpiredRounds(): Promise<void> {
    const now = new Date();
    
    // Найти активные аукционы с истёкшими раундами
    const expiredAuctions = await Auction.find({
      status: AuctionStatus.ACTIVE,
      'rounds.status': 'active',
    }).lean();

    let recovered = 0;
    
    for (const auction of expiredAuctions) {
      const currentRound = auction.rounds[auction.currentRound];
      
      if (currentRound && currentRound.status === 'active') {
        if (new Date(currentRound.endTime) < now) {
          logger.info(`Найден истёкший раунд: аукцион ${auction._id}, раунд ${auction.currentRound}`);
          // RoundManager автоматически обработает это при следующей проверке
          recovered++;
        }
      }
    }
    
    if (recovered > 0) {
      logger.info(`Найдено ${recovered} истёкших раундов для обработки`);
    }
  }

  /**
   * Проверяет соответствие frozen balances и активных ставок.
   * Логирует расхождения для ручной проверки.
   */
  private async verifyFrozenBalances(): Promise<void> {
    // Получаем все активные ставки (не завершённые)
    const activeBids = await Bid.aggregate([
      { 
        $match: { 
          status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] } 
        } 
      },
      {
        $group: {
          _id: '$userId',
          totalLocked: { $sum: '$amount' },
          bidsCount: { $sum: 1 },
        }
      }
    ]);

    if (activeBids.length === 0) {
      logger.info('Нет активных ставок для проверки');
      return;
    }

    // Импортируем User здесь чтобы избежать циклических зависимостей
    const { User } = await import('../models');
    
    let mismatches = 0;
    
    for (const bidGroup of activeBids) {
      const user = await User.findById(bidGroup._id).select('username lockedBalance').lean();
      
      if (!user) continue;
      
      if (user.lockedBalance !== bidGroup.totalLocked) {
        logger.warn(
          `Расхождение баланса: user=${user.username}, ` +
          `lockedBalance=${user.lockedBalance}, ожидаемый=${bidGroup.totalLocked}`
        );
        mismatches++;
      }
    }
    
    if (mismatches > 0) {
      logger.warn(`Найдено ${mismatches} расхождений в frozen balances`);
    } else {
      logger.info('Проверка frozen balances: всё в порядке');
    }
  }

  /**
   * Проверка конкретного аукциона на целостность
   */
  async verifyAuction(auctionId: string): Promise<{
    valid: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];
    
    const auction = await Auction.findById(auctionId).lean();
    if (!auction) {
      return { valid: false, issues: ['Аукцион не найден'] };
    }

    // Проверяем количество распределённых предметов
    const winners = await Bid.countDocuments({
      auctionId,
      status: BidStatus.WON,
    });

    if (winners !== auction.distributedItems) {
      issues.push(
        `Расхождение distributedItems: в аукционе ${auction.distributedItems}, победителей ${winners}`
      );
    }

    // Проверяем что не распределено больше предметов чем есть
    if (auction.distributedItems > auction.totalItems) {
      issues.push(
        `Распределено больше предметов (${auction.distributedItems}) чем доступно (${auction.totalItems})`
      );
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }
}

export const recoveryService = new RecoveryService();
