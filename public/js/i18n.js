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

    // Обработка тултипов
    document.querySelectorAll('[data-i18n-tooltip]').forEach(el => {
      const key = el.getAttribute('data-i18n-tooltip');
      el.setAttribute('data-tooltip', this.t(key));
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

// ==================== TOOLTIP SYSTEM ====================
const TooltipManager = {
  popup: null,
  
  init() {
    // Создаём глобальный элемент тултипа
    this.popup = document.createElement('div');
    this.popup.className = 'tooltip-popup';
    this.popup.style.display = 'none';
    document.body.appendChild(this.popup);
    
    // Обработчики событий
    document.addEventListener('mouseenter', this.handleMouseEnter.bind(this), true);
    document.addEventListener('mouseleave', this.handleMouseLeave.bind(this), true);
    document.addEventListener('click', this.handleClick.bind(this), true);
    document.addEventListener('scroll', () => this.hide(), true);
    window.addEventListener('resize', () => this.hide());
  },
  
  handleMouseEnter(e) {
    if (!e.target || !e.target.closest) return;
    const trigger = e.target.closest('.tooltip-trigger');
    if (!trigger) return;
    
    const text = trigger.getAttribute('data-tooltip');
    if (!text) return;
    
    this.show(trigger, text);
  },
  
  handleMouseLeave(e) {
    if (!e.target || !e.target.closest) return;
    const trigger = e.target.closest('.tooltip-trigger');
    if (trigger) this.hide();
  },
  
  handleClick(e) {
    if (!e.target || !e.target.closest) return;
    // Для мобильных: показать/скрыть по клику
    const trigger = e.target.closest('.tooltip-trigger');
    if (trigger) {
      e.preventDefault();
      const text = trigger.getAttribute('data-tooltip');
      if (this.popup.style.display === 'block') {
        this.hide();
      } else if (text) {
        this.show(trigger, text);
      }
    } else {
      this.hide();
    }
  },
  
  show(trigger, text) {
    this.popup.textContent = text;
    this.popup.style.display = 'block';
    
    const rect = trigger.getBoundingClientRect();
    const popupRect = this.popup.getBoundingClientRect();
    
    // Позиционируем над элементом
    let left = rect.left + rect.width / 2 - popupRect.width / 2;
    let top = rect.top - popupRect.height - 8;
    
    // Проверяем границы экрана
    const padding = 12;
    if (left < padding) left = padding;
    if (left + popupRect.width > window.innerWidth - padding) {
      left = window.innerWidth - popupRect.width - padding;
    }
    if (top < padding) {
      // Показываем снизу, если не влезает сверху
      top = rect.bottom + 8;
      this.popup.classList.add('tooltip-bottom');
    } else {
      this.popup.classList.remove('tooltip-bottom');
    }
    
    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  },
  
  hide() {
    this.popup.style.display = 'none';
  }
};

// Инициализация тултипов после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  TooltipManager.init();
});
