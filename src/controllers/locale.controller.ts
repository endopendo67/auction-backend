import { Request, Response } from 'express';
import { locales, availableLocales, defaultLocale } from '../locales';
import { asyncHandler } from '../middleware/error-handler';

export const localeController = {
  /**
   * Получить список доступных языков
   * GET /api/locales
   */
  getAvailable: asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        locales: availableLocales,
        default: defaultLocale,
      },
    });
  }),

  /**
   * Получить переводы для конкретного языка
   * GET /api/locales/:locale
   */
  getTranslations: asyncHandler(async (req: Request, res: Response) => {
    const { locale } = req.params;

    const translations = locales[locale];
    if (!translations) {
      res.status(404).json({
        success: false,
        error: { message: 'Locale not found', code: 'LOCALE_NOT_FOUND' },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        locale,
        translations,
      },
    });
  }),

  /**
   * Получить все переводы сразу
   * GET /api/locales/all
   */
  getAllTranslations: asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        locales: availableLocales,
        default: defaultLocale,
        translations: locales,
      },
    });
  }),
};
