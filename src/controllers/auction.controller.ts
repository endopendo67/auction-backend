import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { auctionService, bidService, botSimulatorService } from '../services';
import { asyncHandler, createError } from '../middleware/error-handler';
import { socketHandler } from '../websocket/socket-handler';

const createAuctionSchema = z.object({
  title: z.string().min(1).max(128).trim(),
  description: z.string().max(1024).optional(),
  totalItems: z.number().int().positive(),
  startingPrice: z.number().int().positive(),
  minBidIncrement: z.number().int().positive().optional(),
  roundsConfig: z.array(
    z.object({
      itemsToDistribute: z.number().int().positive(),
      durationMs: z.number().int().positive(),
    })
  ).min(1),
  startTime: z.string().datetime().transform((val) => new Date(val)),
  createdBy: z.string().regex(/^[a-f\d]{24}$/i),
  enableBotSimulation: z.boolean().optional().default(false),
  botCount: z.number().int().min(2).max(20).optional().default(5),
});

const startAuctionSchema = z.object({
  enableBotSimulation: z.boolean().optional().default(false),
  botCount: z.number().int().min(2).max(20).optional().default(5),
});

const placeBidSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
  amount: z.number().int().positive(),
});

const quickBidSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
  type: z.enum(['increment', 'outbid']), // increment = +10%, outbid = перебить лидера
});

export const auctionController = {
  // Создание нового аукциона
  create: asyncHandler(async (req: Request, res: Response) => {
    const params = createAuctionSchema.parse(req.body);
    
    const auction = await auctionService.createAuction({
      ...params,
      createdBy: new Types.ObjectId(params.createdBy),
    });
    
    // Уведомляем всех в лобби о новом аукционе
    socketHandler.broadcastNewAuction(auction.id);
    
    res.status(201).json({
      success: true,
      data: auction.toJSON(),
    });
  }),

  // Получить аукцион по ID
  getById: asyncHandler(async (req: Request, res: Response) => {
    const auctionId = new Types.ObjectId(req.params.id);
    const auction = await auctionService.getAuction(auctionId);
    
    if (!auction) {
      throw createError('Аукцион не найден', 404, 'AUCTION_NOT_FOUND');
    }
    
    const minWinningBid = await bidService.getMinWinningBid(auctionId);
    const leaderboard = await bidService.getLeaderboard(auctionId, 10);
    
    res.json({
      success: true,
      data: {
        ...auction.toJSON(),
        minWinningBid,
        topBids: leaderboard.map((b) => ({
          amount: b.amount,
          username: (b.userId as any).username,
          createdAt: b.createdAt,
        })),
      },
    });
  }),

  // Лёгкая версия для поллинга
  getState: asyncHandler(async (req: Request, res: Response) => {
    const auctionId = new Types.ObjectId(req.params.id);
    const roundInfo = await auctionService.getCurrentRoundInfo(auctionId);
    
    if (!roundInfo) {
      throw createError('Аукцион не активен', 400, 'AUCTION_NOT_ACTIVE');
    }
    
    const minWinningBid = await bidService.getMinWinningBid(auctionId);
    
    res.json({
      success: true,
      data: {
        round: roundInfo.round.roundNumber,
        timeRemainingMs: roundInfo.timeRemainingMs,
        isLastRound: roundInfo.isLastRound,
        itemsInRound: roundInfo.round.itemsToDistribute,
        minWinningBid,
      },
    });
  }),

  // Запуск аукциона вручную
  start: asyncHandler(async (req: Request, res: Response) => {
    const auctionId = new Types.ObjectId(req.params.id);
    const { enableBotSimulation, botCount } = startAuctionSchema.parse(req.body || {});
    
    const auction = await auctionService.startAuction(auctionId);
    
    // Запускаем симуляцию ботов если включена
    if (enableBotSimulation) {
      botSimulatorService.startSimulation(auctionId.toString(), botCount).catch(err => {
        console.error('Ошибка запуска ботов:', err);
      });
    }
    
    res.json({
      success: true,
      data: auction.toJSON(),
      botSimulation: enableBotSimulation ? { enabled: true, botCount } : undefined,
    });
  }),

  // Активные аукционы
  listActive: asyncHandler(async (_req: Request, res: Response) => {
    const auctions = await auctionService.getActiveAuctions();
    
    res.json({
      success: true,
      data: auctions,
    });
  }),

  // Все аукционы с пагинацией
  list: asyncHandler(async (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    
    const result = await auctionService.getAllAuctions(page, limit);
    
    res.json({
      success: true,
      data: result.auctions,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.ceil(result.total / limit),
      },
    });
  }),

  // Размещение ставки
  placeBid: asyncHandler(async (req: Request, res: Response) => {
    const auctionId = new Types.ObjectId(req.params.id);
    const { userId, amount } = placeBidSchema.parse(req.body);
    
    const result = await bidService.placeBid(
      auctionId,
      new Types.ObjectId(userId),
      amount
    );
    
    // Мгновенно рассылаем через WebSocket
    socketHandler.broadcastBidUpdate(auctionId.toString(), result.bid.toJSON());
    
    // Если было продление времени — рассылаем отдельно
    if (result.roundExtended) {
      socketHandler.broadcastTimeExtension(auctionId.toString());
    }
    
    res.status(result.isNewBid ? 201 : 200).json({
      success: true,
      data: {
        bid: result.bid.toJSON(),
        isNewBid: result.isNewBid,
        previousAmount: result.previousAmount,
        roundExtended: result.roundExtended,
      },
    });
  }),

  // Лидерборд аукциона
  getLeaderboard: asyncHandler(async (req: Request, res: Response) => {
    const auctionId = new Types.ObjectId(req.params.id);
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    
    const bids = await bidService.getLeaderboard(auctionId, limit);
    
    res.json({
      success: true,
      data: bids.map((bid, index) => ({
        position: index + 1,
        amount: bid.amount,
        username: (bid.userId as any).username,
        status: bid.status,
        createdAt: bid.createdAt,
      })),
    });
  }),

  // Статус ставки пользователя
  getUserBidStatus: asyncHandler(async (req: Request, res: Response) => {
    const auctionId = new Types.ObjectId(req.params.id);
    const userId = new Types.ObjectId(req.params.userId);
    
    const [bid, position, minWinningBid] = await Promise.all([
      bidService.getUserBid(auctionId, userId),
      bidService.getUserPosition(auctionId, userId),
      bidService.getMinWinningBid(auctionId),
    ]);
    
    res.json({
      success: true,
      data: {
        hasBid: !!bid,
        bid: bid?.toJSON() || null,
        position: position?.position || null,
        totalBidders: position?.totalBidders || 0,
        minWinningBid,
        isWinning: position ? position.position <= (minWinningBid || 0) : false,
      },
    });
  }),

  // Победители завершённого аукциона
  getWinners: asyncHandler(async (req: Request, res: Response) => {
    const auctionId = new Types.ObjectId(req.params.id);
    const winners = await bidService.getAuctionWinners(auctionId);
    
    res.json({
      success: true,
      data: winners.map((bid, index) => ({
        position: index + 1,
        itemNumber: bid.itemNumber,
        amount: bid.amount,
        username: (bid.userId as any).username,
        round: bid.round,
      })),
    });
  }),

  // Быстрая ставка (+10% или перебить лидера)
  quickBid: asyncHandler(async (req: Request, res: Response) => {
    const auctionId = new Types.ObjectId(req.params.id);
    const { userId, type } = quickBidSchema.parse(req.body);
    const userObjectId = new Types.ObjectId(userId);
    
    // Получаем текущую ситуацию
    const [leaderboard, userBid, auction] = await Promise.all([
      bidService.getLeaderboard(auctionId, 1),
      bidService.getUserBid(auctionId, userObjectId),
      auctionService.getAuction(auctionId),
    ]);
    
    if (!auction) {
      throw createError('Аукцион не найден', 404, 'AUCTION_NOT_FOUND');
    }
    
    const topBid = leaderboard[0]?.amount || auction.startingPrice;
    const currentBid = userBid?.amount || 0;
    const minIncrement = auction.minBidIncrement || 1;
    
    let newAmount: number;
    
    if (type === 'increment') {
      // +10% от текущей ставки пользователя (или от стартовой)
      const base = currentBid || auction.startingPrice;
      newAmount = Math.ceil(base * 1.1);
    } else {
      // Перебить лидера на минимальный шаг
      newAmount = topBid + minIncrement;
    }
    
    // Минимум — текущая ставка + 1
    if (newAmount <= currentBid) {
      newAmount = currentBid + minIncrement;
    }
    
    const result = await bidService.placeBid(auctionId, userObjectId, newAmount);
    
    // Мгновенно рассылаем через WebSocket
    socketHandler.broadcastBidUpdate(auctionId.toString(), result.bid.toJSON());
    
    if (result.roundExtended) {
      socketHandler.broadcastTimeExtension(auctionId.toString());
    }
    
    res.status(result.isNewBid ? 201 : 200).json({
      success: true,
      data: {
        bid: result.bid.toJSON(),
        isNewBid: result.isNewBid,
        previousAmount: result.previousAmount,
        roundExtended: result.roundExtended,
        quickBidType: type,
      },
    });
  }),
};
