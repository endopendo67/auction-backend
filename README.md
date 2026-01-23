# Backend Auction Challenge

Многораундовая аукционная система по мотивам Telegram Gift Auctions.

**[Live Demo](https://auction-demo.lol)** • **[Video Demo](https://youtu.be/yhGUwJE19ng)**

---

## Быстрый запуск (Docker)

```bash
git clone https://github.com/endopendo67/auction-backend.git
cd auction-backend
docker-compose up -d
```

Открой http://localhost

---

## Ручной запуск

### Требования

- Node.js 20+
- MongoDB 6+
- Redis 7+

### Установка

```bash
git clone https://github.com/endopendo67/auction-backend.git
cd auction-backend
npm install
```

### Настройка

Создай `.env` файл:

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/auction_db
REDIS_URL=redis://localhost:6379
NODE_ENV=development
```

### Запуск MongoDB и Redis

```bash
# MongoDB
mongod --dbpath /data/db

# Redis
redis-server
```

### Сборка и запуск

```bash
npm run build
npm start
```

Или в режиме разработки:

```bash
npm run dev
```

Открой http://localhost:3000

---

## Как работает аукцион

### Раунды

Аукцион делится на раунды. В каждом раунде топ-N участников получают товар:

```
Раунд 1 (5 мин)  → Топ-30 получают товар
Раунд 2 (3 мин)  → Топ-30 получают товар  
Раунд 3 (2 мин)  → Топ-40 получают остальное
                   Проигравшие → возврат денег
```

### Ранжирование

1. Выше ставка = лучше позиция
2. При равных ставках — кто раньше поставил

### Anti-sniping

Ставка в последние 30 секунд может продлить раунд на 60 секунд (шанс 50%, максимум 1 раз).

### Деньги

- Ставка блокирует средства
- Победа — списание
- Проигрыш — возврат

---

## Тестирование

### С ботами (рекомендую)

1. Создай аукцион
2. Включи "Симуляция торгов"
3. Смотри как боты торгуются

### Стресс-тест

```bash
docker-compose exec app npx tsx scripts/stress-test.ts
```

5000 товаров, 6000 ботов, ~300 запросов/сек.

---

## API

```http
# Вход
POST /api/auth/login
{ "username": "player1" }

# Создать аукцион
POST /api/auctions
{
  "title": "Test",
  "totalItems": 10,
  "startingPrice": 100,
  "roundsConfig": [
    { "itemsToDistribute": 3, "durationMs": 120000 },
    { "itemsToDistribute": 3, "durationMs": 90000 },
    { "itemsToDistribute": 4, "durationMs": 60000 }
  ],
  "createdBy": "user_id"
}

# Ставка
POST /api/auctions/:id/bid
{ "userId": "user_id", "amount": 500 }
```

---

## WebSocket

```javascript
socket.emit('auction:join', auctionId);

socket.on('auction:leaderboard', (data) => { });
socket.on('auction:new_bid', (data) => { });
socket.on('auction:winners', (data) => { });
```

---

## Архитектура

**Атомарные операции** вместо транзакций — нет WriteConflict при высокой нагрузке.

**WebSocket** для real-time обновлений.

**Redis** для кэширования лидерборда.

---

## Стек

Node.js • TypeScript • MongoDB • Redis • Socket.IO • Docker

---

## Допущения

| Вопрос | Решение |
|--------|---------|
| Понизить ставку? | Нельзя |
| Минимальный шаг | +1⭐ |
| Выиграл в нескольких раундах? | Получает товар в первом |

---

*Backend Auction Challenge • CryptoBot • $30,000*
