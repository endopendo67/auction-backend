# Telegram Gift Auctions

Бэкенд для многораундовой аукционной системы по типу Telegram Gift Auctions.

**Демо:** [auction-demo.lol](https://auction-demo.lol) • **Видео:** [Streamable](https://streamable.com/cl5w2s)

---

## 🎮 Для судей — быстрый тест (2 минуты)

### Шаг 1: Откройте демо
→ [auction-demo.lol](https://auction-demo.lol)

### Шаг 2: Войдите
```
Введите любой username → Нажмите "Войти"
Начальный баланс: 10000
```

### Шаг 3: Выберите аукцион или создайте новый
```
Нажмите на карточку аукциона в списке
```

### Шаг 4: Сделайте ставку
```
- Введите сумму или используйте быстрые ставки (+10%, Outbid)
- Лидерборд обновляется мгновенно (WebSocket)
- Попробуйте ставку в последние 30 сек → увидите anti-snipe!
```

### Шаг 5: Запустите ботов (Docker)
```bash
docker-compose exec app npx tsx scripts/bots.ts
```

### Что проверить:
- ✅ Real-time обновление лидерборда
- ✅ Anti-snipe (ставка в последние 30 сек продлевает раунд)
- ✅ Баланс замораживается при ставке
- ✅ Победители получают товары, проигравшие — возврат
- ✅ Пагинация лидерборда (50 записей на страницу)

---

## Быстрый старт

### Docker (рекомендуется)

```bash
git clone https://github.com/endopendo67/auction-backend.git
cd auction-backend
docker-compose up -d
```

Открываем http://localhost:3000 — готово.

### Локально

```bash
# MongoDB с replica set
brew services start mongodb-community
mongosh --eval "rs.initiate()"

# Redis (опционально)
brew services start redis

# Приложение
npm install
cp env.example .env
npm run dev
```

---

## Архитектура

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│    Frontend     │◄─────►│     Backend     │◄─────►│    MongoDB      │
│   (HTML/JS)     │  WS   │  Express + WS   │       │  (Replica Set)  │
└─────────────────┘       └────────┬────────┘       └─────────────────┘
                                   │
                                   ▼
                          ┌─────────────────┐
                          │      Redis      │
                          │  (Кэш + Rate)   │
                          └─────────────────┘
```

### Поток данных

```
1. Ставка
   User → POST /bid → BidService.placeBid()
   → Проверка баланса → Заморозка средств → Сохранение
   → WebSocket broadcast → Обновление лидерборда

2. Завершение раунда
   Timer → RoundManager → processRoundWinners()
   → Определение победителей → Списание/возврат средств
   → Переход к следующему раунду → WebSocket broadcast
```

---

## Стек

- **Node.js + TypeScript** — основа
- **MongoDB** — данные + транзакции (replica set)
- **Redis** — кэш лидерборда + rate limiting
- **Socket.IO** — real-time обновления
- **Zod** — валидация входных данных

---

## Как работает

### Многораундовая система

Аукцион разбит на раунды. В каждом раунде топ-N ставок получают товар, остальные переходят в следующий раунд.

```
Раунд 1: топ-100 → получают товар, остальные → раунд 2
Раунд 2: топ-50  → получают товар, остальные → раунд 3
Раунд 3: топ-50  → получают товар, остальные → возврат
```

### Ранжирование

1. По сумме ставки (больше = выше)
2. При равных — кто раньше поставил

### Anti-Sniping

Ставка в последние 30 секунд продлевает раунд на 60 секунд.

---

## Финансы

Деньги не теряются и не дублируются.

```
Ставка 1000    → блокируем 1000 (lockedBalance += 1000)
Повышаем 1500  → блокируем +500 (только разницу)
Выигрыш        → списываем (balance -= 1500, lockedBalance -= 1500)
Проигрыш       → разблокируем (lockedBalance -= 1500)
```

### Защиты

- **Атомарные операции** — проверка и обновление в одном запросе
- **MongoDB транзакции** — snapshot isolation
- **Retry с backoff** — до 5 попыток при WriteConflict
- **Аудит** — все операции в коллекции Transaction

---

## Edge Cases

| Случай | Решение |
|--------|---------|
| Ставка на границе времени | Буфер 100мс |
| Спам ставками | Rate limit 10/5сек (Redis) |
| Нет участников | Раунд завершается пустым |
| Участников < товаров | Все выигрывают |
| Равные ставки | Кто раньше (createdAt index) |
| Сумма > 1 млрд | Отклоняем |
| WriteConflict | Retry до 5 раз с backoff |
| Сервер рестарт | Recovery восстанавливает таймеры |

---

## Оптимизации

- Составной индекс `{ auctionId, status, amount, createdAt }` для лидерборда
- Lean queries + projection (только нужные поля)
- Redis кэш лидерборда (TTL 2 сек)
- WebSocket throttling 200мс
- Пагинация лидерборда (50 записей)

---

## Тестирование

```bash
npm run seed                              # тестовые данные
npx tsx scripts/bots.ts                   # 50 ботов с разными стратегиями
npx tsx scripts/load-test.ts --bots=100   # нагрузочный тест
npm run test:stress                       # стресс-тест 5000+ ботов
```

### Результаты stress-test (5000 ботов)

| Метрика | Значение |
|---------|----------|
| Пиковый RPS | ~200 req/s |
| Latency P50 | 45ms |
| Latency P95 | 180ms |
| Success rate | 95%+ |
| Баланс сходится | ✅ |

---

## API

```
POST /api/auth/login         { username }
GET  /api/auth/me
POST /api/auth/logout

GET  /api/auctions
POST /api/auctions           { title, totalItems, startingPrice, roundsConfig }
GET  /api/auctions/:id
POST /api/auctions/:id/start
POST /api/auctions/:id/bid   { amount }
POST /api/auctions/:id/quick-bid   { type: "increment" | "outbid" }
GET  /api/auctions/:id/leaderboard?page=1&limit=50

GET  /api/users/:id/balance
POST /api/users/:id/deposit  { amount }
```

### WebSocket

```javascript
socket.emit('auction:join', auctionId);
socket.on('auction:new_bid', (data) => {});
socket.on('auction:time_extended', (data) => {});
socket.on('auction:leaderboard', (data) => {});
socket.on('auction:round_ended', (data) => {});
```

---

## Структура

```
src/
├── services/          # бизнес-логика
│   ├── auction.service.ts
│   ├── bid.service.ts
│   ├── balance.service.ts
│   ├── round-manager.service.ts
│   └── redis.service.ts
├── models/            # User, Auction, Bid, Transaction
├── controllers/       # HTTP endpoints
├── websocket/         # Socket.IO handlers
└── middleware/        # auth, errors

scripts/
├── seed.ts            # тестовые данные
├── bots.ts            # симуляция 50 ботов
├── load-test.ts       # нагрузочный тест
└── stress-test.ts     # экстремальный стресс
```

---

## Конфиг

| Переменная | Default |
|------------|---------|
| PORT | 3000 |
| MONGODB_URI | mongodb://localhost:27017/auction_db |
| REDIS_URI | redis://localhost:6379 |
| ANTI_SNIPE_THRESHOLD_MS | 30000 |
| ANTI_SNIPE_EXTENSION_MS | 60000 |

---

Сделано для [CryptoBot Backend Challenge](https://t.me/CryptoBotRU)
