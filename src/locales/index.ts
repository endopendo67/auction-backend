import { ru } from './ru';
import { en } from './en';

export const locales: Record<string, Record<string, string>> = {
  ru,
  en,
};

export const availableLocales = Object.keys(locales);
export const defaultLocale = 'en';
