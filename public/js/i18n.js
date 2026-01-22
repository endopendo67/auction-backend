/*
 * Модуль локализации
 * Загружает переводы с сервера по мере необходимости
 */

const I18n = {
  translations: {},
  currentLocale: 'ru',
  availableLocales: ['en', 'ru'],
  loading: null,

  // Загрузить переводы для конкретного языка
  async loadLocale(locale) {
    if (this.translations[locale]) {
      return this.translations[locale];
    }

    try {
      const res = await fetch(`/api/locales/${locale}`);
      const data = await res.json();
      
      if (data.success) {
        this.translations[locale] = data.data.translations;
        return this.translations[locale];
      }
    } catch (e) {
      console.error('Не удалось загрузить переводы:', e);
    }
    
    return {};
  },

  // Сменить язык
  async setLocale(locale) {
    if (!this.availableLocales.includes(locale)) {
      console.warn(`Язык ${locale} недоступен`);
      return;
    }

    await this.loadLocale(locale);
    this.currentLocale = locale;
    localStorage.setItem('locale', locale);
    document.documentElement.lang = locale;
    
    this.updatePage();
  },

  // Получить перевод
  t(key, params = {}) {
    const dict = this.translations[this.currentLocale] || {};
    let text = dict[key] || key;
    
    // Подстановка параметров {name} -> value
    Object.entries(params).forEach(([k, v]) => {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    });
    
    return text;
  },

  // Обновить все элементы с data-i18n
  updatePage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = this.t(key);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = this.t(el.getAttribute('data-i18n-placeholder'));
    });
  },

  // Инициализация при загрузке страницы
  async init() {
    const saved = localStorage.getItem('locale');
    const browserLang = navigator.language.split('-')[0];
    const locale = saved || (this.availableLocales.includes(browserLang) ? browserLang : 'ru');
    
    await this.setLocale(locale);
    return this;
  }
};

// Короткая функция для удобства
window.t = (key, params) => I18n.t(key, params);
