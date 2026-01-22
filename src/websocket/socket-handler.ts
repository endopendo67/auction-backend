import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { Types } from 'mongoose';
import { roundManagerService, RoundEvent, auctionService, bidService } from '../services';
import { logger } from '../utils/logger';

interface AuctionRoom {
  auctionId: string;
  clients: Set<string>;
}

// Для батчинга обновлений лидерборда (оптимизация под тысячи клиентов)
interface PendingLeaderboardUpdate {
  auctionId: string;
  timeout: NodeJS.Timeout;
}

class SocketHandler {
  private io: Server | null = null;
  private auctionRooms: Map<string, AuctionRoom> = new Map();
  private lobbyClients: Set<string> = new Set(); // Клиенты в лобби (список аукционов)
  private pendingLeaderboardUpdates: Map<string, PendingLeaderboardUpdate> = new Map();
  
  // Throttle: не чаще чем раз в 500мс отправляем обновления лидерборда
  private readonly LEADERBOARD_THROTTLE_MS = 500;

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
      
      // Уведомляем лобби об изменении статуса аукциона
      if (event.type === 'auction_completed' || event.type === 'round_ended') {
        this.broadcastAuctionsUpdate();
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

      // Отправляем текущее состояние
      const roundInfo = await auctionService.getCurrentRoundInfo(new Types.ObjectId(auctionId));
      const minWinningBid = await bidService.getMinWinningBid(new Types.ObjectId(auctionId));

      socket.emit('auction:joined', {
        auctionId,
        auction: auction.toJSON(),
        roundInfo,
        minWinningBid,
        subscribersCount: room.clients.size,
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
      const leaderboard = await bidService.getLeaderboard(new Types.ObjectId(auctionId), 50);

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

  // Рассылка новой ставки с throttled лидербордом
  async broadcastBidUpdate(auctionId: string, bid: unknown): Promise<void> {
    if (!this.io) return;

    const minWinningBid = await bidService.getMinWinningBid(new Types.ObjectId(auctionId));

    // Сразу отправляем инфо о ставке (легковесное)
    this.io.to(`auction:${auctionId}`).emit('auction:new_bid', {
      auctionId,
      bid,
      minWinningBid,
    });

    // Throttled обновление лидерборда
    this.scheduleLeaderboardUpdate(auctionId);
  }

  // Throttled обновление лидерборда — не чаще чем раз в LEADERBOARD_THROTTLE_MS
  private scheduleLeaderboardUpdate(auctionId: string): void {
    const existing = this.pendingLeaderboardUpdates.get(auctionId);
    if (existing) return; // Уже запланировано

    const timeout = setTimeout(async () => {
      this.pendingLeaderboardUpdates.delete(auctionId);
      await this.broadcastLeaderboard(auctionId);
    }, this.LEADERBOARD_THROTTLE_MS);

    this.pendingLeaderboardUpdates.set(auctionId, { auctionId, timeout });
  }

  // Отправка лидерборда всем в комнате аукциона
  private async broadcastLeaderboard(auctionId: string): Promise<void> {
    if (!this.io) return;

    try {
      const leaderboard = await bidService.getLeaderboard(new Types.ObjectId(auctionId), 50);
      
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
}

export const socketHandler = new SocketHandler();
