import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { auctionService, bidService } from '../services';
import { asyncHandler, createError } from '../middleware/error-handler';

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
});

const placeBidSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
  amount: z.number().int().positive(),
});

export const auctionController = {
  // Создание нового аукциона
  create: asyncHandler(async (req: Request, res: Response) => {
    const params = createAuctionSchema.parse(req.body);
    
    const auction = await auctionService.createAuction({
      ...params,
      createdBy: new Types.ObjectId(params.createdBy),
    });
    
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
    const auction = await auctionService.startAuction(auctionId);
    
    res.json({
      success: true,
      data: auction.toJSON(),
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
};
