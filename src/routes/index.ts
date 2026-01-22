import { Router } from 'express';
import { userRoutes } from './user.routes';
import { auctionRoutes } from './auction.routes';
import { authRoutes } from './auth.routes';
import { localeRoutes } from './locale.routes';

const router = Router();

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Роуты
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/auctions', auctionRoutes);
router.use('/locales', localeRoutes);

export { router as apiRoutes };
