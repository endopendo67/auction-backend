# Telegram Gift Auctions

Бэкенд для многораундовой аукционной системы по типу Telegram Gift Auctions.

**Демо:** [auction-demo.lol](https://auction-demo.lol) • **Видео:** [Streamable](https://streamable.com/cl5w2s)

---

## Быстрый старт

### Docker

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

## Стек

- **Node.js + TypeScript** — основа
- **MongoDB** — данные + транзакции
- **Redis** — кэш + rate limiting
- **Socket.IO** — real-time
- **Zod** — валидация

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
- **Retry с backoff** — до 5 попыток при конфликте
- **Аудит** — все операции в коллекции Transaction

---

## Edge Cases

| Случай | Решение |
|--------|---------|
| Ставка на границе времени | Буфер 100мс |
| Спам ставками | Rate limit 10/5сек |
| Нет участников | Раунд завершается пустым |
| Участников < товаров | Все выигрывают |
| Равные ставки | Кто раньше |
| Сумма > 1 млрд | Отклоняем |

---

## Оптимизации

- Составной индекс для лидерборда
- Lean queries + projection
- Redis кэш (TTL 1-2 сек)
- WebSocket throttling 200мс

---

## Тестирование

```bash
npm run seed                              # тестовые данные
npx tsx scripts/bots.ts                   # 50 ботов
npx tsx scripts/load-test.ts --bots=100   # нагрузка
npm run test:stress                       # 5000+ ботов
```

Проверяется: RPS, latency, целостность балансов.

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
POST /api/auctions/:id/bid   { userId, amount }
GET  /api/auctions/:id/leaderboard

GET  /api/users/:id/balance
POST /api/users/:id/deposit  { amount }
```

### WebSocket

```javascript
socket.emit('auction:join', auctionId);
socket.on('auction:new_bid', (data) => {});
socket.on('auction:time_extended', (data) => {});
socket.on('auction:leaderboard', (data) => {});
```

---

## Структура

```
src/
├── services/          # бизнес-логика
├── models/            # User, Auction, Bid, Transaction
├── controllers/       # HTTP
├── websocket/         # Socket.IO
└── middleware/        # auth, errors

scripts/
├── seed.ts            # данные
├── bots.ts            # симуляция
├── load-test.ts       # нагрузка
└── stress-test.ts     # стресс
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
