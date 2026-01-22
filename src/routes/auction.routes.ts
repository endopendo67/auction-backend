import { Router } from 'express';
import { auctionController } from '../controllers/auction.controller';

const router = Router();

// Create auction
router.post('/', auctionController.create);

// List all auctions
router.get('/', auctionController.list);

// List active auctions
router.get('/active', auctionController.listActive);

// Get auction by ID
router.get('/:id', auctionController.getById);

// Get auction state (light, for polling)
router.get('/:id/state', auctionController.getState);

// Start auction manually
router.post('/:id/start', auctionController.start);

// Place bid
router.post('/:id/bid', auctionController.placeBid);

// Quick bid (+10% or outbid leader)
router.post('/:id/quick-bid', auctionController.quickBid);

// Get leaderboard
router.get('/:id/leaderboard', auctionController.getLeaderboard);

// Get winners (for completed auctions)
router.get('/:id/winners', auctionController.getWinners);

// Get user's bid status in auction
router.get('/:id/user/:userId/status', auctionController.getUserBidStatus);

export { router as auctionRoutes };
