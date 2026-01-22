import { Router } from 'express';
import { userController } from '../controllers/user.controller';

const router = Router();

// Create user
router.post('/', userController.create);

// Get or create user (for demo)
router.post('/get-or-create', userController.getOrCreate);

// List all users
router.get('/', userController.list);

// Get user by ID
router.get('/:id', userController.getById);

// Get user by username
router.get('/username/:username', userController.getByUsername);

// Get user balance
router.get('/:id/balance', userController.getBalance);

// Deposit to user account
router.post('/:id/deposit', userController.deposit);

// Get user transactions
router.get('/:id/transactions', userController.getTransactions);

// Get user bid history
router.get('/:id/bids', userController.getBidHistory);

export { router as userRoutes };
