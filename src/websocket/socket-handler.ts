import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { Types } from 'mongoose';
import { roundManagerService, RoundEvent, auctionService, bidService } from '../services';
import { logger } from '../utils/logger';

interface AuctionRoom {
  auctionId: string;
  clients: Set<string>;
}

class SocketHandler {
  private io: Server | null = null;
  private auctionRooms: Map<string, AuctionRoom> = new Map();
  private lobbyClients: Set<string> = new Set();
  
  // Throttle для лидерборда — адаптивный под нагрузку
  private readonly MIN_THROTTLE_MS = 50;  // Минимум 50ms
  private readonly MAX_THROTTLE_MS = 200; // Максимум 200ms
  private pendingLeaderboardUpdates: Map<string, NodeJS.Timeout> = new Map();
  private lastLeaderboardTime: Map<string, number> = new Map();
  private bidCountPerSecond: Map<string, number> = new Map(); // Счётчик ставок для адаптации

  initialize(httpServer: HttpServer): Server {
    this.io = new Server(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      pingTimeout: 60000,
      pingInterval: 25000,
      // Оптимизация для большого числа подключений
      perMessageDeflate: false, // Отключаем сжатие (экономит CPU)
      maxHttpBufferSize: 1e6, // 1MB макс размер сообщения
    });

    this.io.on('connection', (socket) => this.handleConnection(socket));

    // Подписываемся на события раундов
    roundManagerService.on('round_event', (event: RoundEvent) => {
      this.broadcastToAuction(event.auctionId, 'auction:event', event);
      
      // Уведомляем лобби об изменении статуса (мгновенно)
      if (event.type === 'round_started' || event.type === 'round_ended' || event.type === 'auction_completed') {
        this.broadcastAuctionStatus(event.auctionId);
      }
      
      // Очищаем ресурсы при завершении аукциона
      if (event.type === 'auction_completed') {
        this.cleanupAuction(event.auctionId);
      }
    });

    logger.info('WebSocket сервер запущен');
    return this.io;
  }

  private handleConnection(socket: Socket): void {
    logger.debug(`Клиент подключился: ${socket.id}`);

    // Подписка на лобби (список аукционов)
    socket.on('lobby:join', () => {
      this.lobbyClients.add(socket.id);
      socket.join('lobby');
      logger.debug(`Клиент ${socket.id} в лобби`);
    });

    socket.on('lobby:leave', () => {
      this.lobbyClients.delete(socket.id);
      socket.leave('lobby');
    });

    socket.on('auction:join', async (auctionId: string) => {
      await this.handleJoinAuction(socket, auctionId);
    });

    socket.on('auction:leave', (auctionId: string) => {
      this.handleLeaveAuction(socket, auctionId);
    });

    socket.on('auction:subscribe_leaderboard', async (auctionId: string) => {
      await this.sendLeaderboardUpdate(socket, auctionId);
    });

    socket.on('disconnect', () => {
      this.handleDisconnect(socket);
    });
  }

  private async handleJoinAuction(socket: Socket, auctionId: string): Promise<void> {
    try {
      const auction = await auctionService.getAuction(new Types.ObjectId(auctionId));
      
      if (!auction) {
        socket.emit('error', { message: 'Аукцион не найден' });
        return;
      }

      socket.join(`auction:${auctionId}`);

      // Добавляем в наш трекер комнат
      let room = this.auctionRooms.get(auctionId);
      if (!room) {
        room = { auctionId, clients: new Set() };
        this.auctionRooms.set(auctionId, room);
      }
      room.clients.add(socket.id);

      // Отправляем текущее состояние + лидерборд МГНОВЕННО
      const [roundInfo, minWinningBid, leaderboard] = await Promise.all([
        auctionService.getCurrentRoundInfo(new Types.ObjectId(auctionId)),
        bidService.getMinWinningBid(new Types.ObjectId(auctionId)),
        bidService.getLeaderboard(new Types.ObjectId(auctionId), 500), // Увеличено для пагинации
      ]);

      socket.emit('auction:joined', {
        auctionId,
        auction: auction.toJSON(),
        roundInfo,
        minWinningBid,
        subscribersCount: room.clients.size,
      });

      // Сразу отправляем лидерборд клиенту (до 500 записей для пагинации)
      socket.emit('auction:leaderboard', {
        auctionId,
        leaderboard: leaderboard.map((bid, index) => ({
          position: index + 1,
          amount: bid.amount,
          username: (bid.userId as any)?.username || 'Unknown',
          status: bid.status,
        })),
      });

      logger.debug(`Клиент ${socket.id} присоединился к аукциону ${auctionId}`);
    } catch (error) {
      logger.error(`Ошибка подключения к аукциону: ${error}`);
      socket.emit('error', { message: 'Не удалось подключиться к аукциону' });
    }
  }

  private handleLeaveAuction(socket: Socket, auctionId: string): void {
    socket.leave(`auction:${auctionId}`);

    const room = this.auctionRooms.get(auctionId);
    if (room) {
      room.clients.delete(socket.id);
      if (room.clients.size === 0) {
        this.auctionRooms.delete(auctionId);
      }
    }

    logger.debug(`Клиент ${socket.id} покинул аукцион ${auctionId}`);
  }

  private handleDisconnect(socket: Socket): void {
    // Удаляем из лобби
    this.lobbyClients.delete(socket.id);
    
    // Удаляем из всех комнат
    for (const [auctionId, room] of this.auctionRooms) {
      if (room.clients.has(socket.id)) {
        room.clients.delete(socket.id);
        if (room.clients.size === 0) {
          this.auctionRooms.delete(auctionId);
        }
      }
    }

    logger.debug(`Клиент отключился: ${socket.id}`);
  }

  private async sendLeaderboardUpdate(socket: Socket, auctionId: string): Promise<void> {
    try {
      const leaderboard = await bidService.getLeaderboard(new Types.ObjectId(auctionId), 500);

      socket.emit('auction:leaderboard', {
        auctionId,
        leaderboard: leaderboard.map((bid, index) => ({
          position: index + 1,
          amount: bid.amount,
          username: (bid.userId as any)?.username || 'Unknown',
          status: bid.status,
        })),
      });
    } catch (error) {
      logger.error(`Ошибка отправки лидерборда: ${error}`);
    }
  }

  // Рассылка сообщения всем в комнате аукциона
  broadcastToAuction(auctionId: string, event: string, data: unknown): void {
    if (!this.io) return;
    this.io.to(`auction:${auctionId}`).emit(event, data);
  }

  // Уведомление лобби о новом/изменённом аукционе
  async broadcastAuctionsUpdate(): Promise<void> {
    if (!this.io || this.lobbyClients.size === 0) return;
    
    try {
      const result = await auctionService.getAllAuctions(1, 20);
      this.io.to('lobby').emit('lobby:auctions_updated', {
        auctions: result.auctions.map(a => a.toJSON()),
        total: result.total,
      });
    } catch (error) {
      logger.error(`Ошибка рассылки аукционов: ${error}`);
    }
  }

  // Уведомление о создании нового аукциона
  async broadcastNewAuction(auctionId: string): Promise<void> {
    if (!this.io) return;
    
    try {
      const auction = await auctionService.getAuction(new Types.ObjectId(auctionId));
      if (auction) {
        this.io.to('lobby').emit('lobby:new_auction', {
          auction: auction.toJSON(),
        });
      }
    } catch (error) {
      logger.error(`Ошибка рассылки нового аукциона: ${error}`);
    }
  }

  // Уведомление об изменении статуса аукциона (начат, завершён и т.д.)
  async broadcastAuctionStatus(auctionId: string): Promise<void> {
    if (!this.io) return;
    
    try {
      const auction = await auctionService.getAuction(new Types.ObjectId(auctionId));
      if (auction) {
        this.io.to('lobby').emit('lobby:auction_status', {
          auction: auction.toJSON(),
        });
      }
    } catch (error) {
      logger.error(`Ошибка рассылки статуса аукциона: ${error}`);
    }
  }

  // Рассылка новой ставки — МГНОВЕННО, лидерборд с throttle для оптимизации
  async broadcastBidUpdate(auctionId: string, bid: unknown): Promise<void> {
    if (!this.io) return;

    const minWinningBid = await bidService.getMinWinningBid(new Types.ObjectId(auctionId));

    // Мгновенно отправляем инфо о ставке (всегда)
    this.io.to(`auction:${auctionId}`).emit('auction:new_bid', {
      auctionId,
      bid,
      minWinningBid,
    });

    // Лидерборд с throttle для высокой нагрузки (100ms)
    this.scheduleLeaderboardBroadcast(auctionId);
  }

  // Адаптивный throttle — чем больше нагрузка, тем реже обновляем
  private scheduleLeaderboardBroadcast(auctionId: string): void {
    const now = Date.now();
    const lastTime = this.lastLeaderboardTime.get(auctionId) || 0;
    
    // Считаем ставки для адаптивного throttle
    const bidCount = (this.bidCountPerSecond.get(auctionId) || 0) + 1;
    this.bidCountPerSecond.set(auctionId, bidCount);
    
    // Сбрасываем счётчик каждую секунду
    if (now - lastTime > 1000) {
      this.bidCountPerSecond.set(auctionId, 1);
    }
    
    // Адаптивный throttle: при высокой нагрузке (>50 RPS) увеличиваем интервал
    const throttleMs = Math.min(
      this.MAX_THROTTLE_MS,
      Math.max(this.MIN_THROTTLE_MS, bidCount * 2)
    );
    
    // Если уже есть pending update — ничего не делаем
    if (this.pendingLeaderboardUpdates.has(auctionId)) {
      return;
    }
    
    // Если прошло достаточно времени — отправляем сразу
    if (now - lastTime >= throttleMs) {
      this.broadcastLeaderboardNow(auctionId);
    } else {
      // Иначе планируем на потом
      const delay = Math.max(10, throttleMs - (now - lastTime));
      const timeout = setTimeout(() => {
        this.pendingLeaderboardUpdates.delete(auctionId);
        this.broadcastLeaderboardNow(auctionId);
      }, delay);
      this.pendingLeaderboardUpdates.set(auctionId, timeout);
    }
  }

  // Немедленная отправка лидерборда
  private async broadcastLeaderboardNow(auctionId: string): Promise<void> {
    if (!this.io) return;
    
    this.lastLeaderboardTime.set(auctionId, Date.now());

    try {
      const leaderboard = await bidService.getLeaderboard(new Types.ObjectId(auctionId), 500);
      
      this.io.to(`auction:${auctionId}`).emit('auction:leaderboard', {
        auctionId,
        leaderboard: leaderboard.map((bid, index) => ({
          position: index + 1,
          amount: bid.amount,
          username: (bid.userId as any)?.username || 'Unknown',
          status: bid.status,
        })),
      });
    } catch (error) {
      logger.error(`Ошибка рассылки лидерборда: ${error}`);
    }
  }

  // Рассылка о продлении времени (anti-sniping)
  async broadcastTimeExtension(auctionId: string): Promise<void> {
    if (!this.io) return;

    const roundInfo = await auctionService.getCurrentRoundInfo(new Types.ObjectId(auctionId));

    if (roundInfo) {
      this.io.to(`auction:${auctionId}`).emit('auction:time_extended', {
        auctionId,
        newEndTime: roundInfo.round.endTime,
        timeRemainingMs: roundInfo.timeRemainingMs,
        extensionCount: roundInfo.round.extensionCount,
      });
    }
  }

  getIO(): Server | null {
    return this.io;
  }

  getAuctionSubscriberCount(auctionId: string): number {
    const room = this.auctionRooms.get(auctionId);
    return room?.clients.size || 0;
  }
  
  getLobbySize(): number {
    return this.lobbyClients.size;
  }

  /**
   * Очистка ресурсов аукциона (вызывать при завершении)
   */
  cleanupAuction(auctionId: string): void {
    // Отменяем pending leaderboard updates
    const pending = this.pendingLeaderboardUpdates.get(auctionId);
    if (pending) {
      clearTimeout(pending);
      this.pendingLeaderboardUpdates.delete(auctionId);
    }
    
    // Очищаем счётчики
    this.lastLeaderboardTime.delete(auctionId);
    this.bidCountPerSecond.delete(auctionId);
    
    logger.debug(`Ресурсы очищены для аукциона ${auctionId}`);
  }
}

export const socketHandler = new SocketHandler();
