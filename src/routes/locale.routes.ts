import { Router } from 'express';
import { localeController } from '../controllers/locale.controller';

const router = Router();

router.get('/', localeController.getAvailable);
router.get('/all', localeController.getAllTranslations);
router.get('/:locale', localeController.getTranslations);

export { router as localeRoutes };
