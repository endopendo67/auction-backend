# Auction Platform

Бэкенд аукционной платформы с многораундовой системой распределения товаров.

[Демо](https://auction-demo.lol)

## Запуск

```bash
docker-compose up -d
```

Приложение доступно на `http://localhost`

## Описание

Система проводит аукционы в несколько раундов. В каждом раунде определённое количество участников с наивысшими ставками получают товар. Остальные переходят в следующий раунд или получают возврат средств.

### Пример конфигурации

10 товаров, 3 раунда:
- Раунд 1 (120 сек): 3 победителя
- Раунд 2 (90 сек): 3 победителя
- Раунд 3 (60 сек): 4 победителя

### Ранжирование

Позиция определяется суммой ставки. При равных ставках — временем размещения (кто раньше, тот выше).

### Anti-sniping

Ставка в последние 30 секунд раунда автоматически продлевает его на 60 секунд.

## Технологии

- Node.js, TypeScript, Express
- MongoDB (replica set для атомарности)
- Redis (кэширование, rate limiting)
- Socket.IO (real-time обновления)

## Работа с балансом

При размещении ставки средства блокируются. При повышении ставки блокируется только разница. После завершения раунда:
- Победители: средства списываются
- Проигравшие: средства разблокируются

Все операции выполняются атомарно через `findOneAndUpdate` с условиями в фильтре. Транзакции не используются — это исключает WriteConflict при высокой нагрузке.

## Симуляция

При создании аукциона можно включить симуляцию торгов. Система создаст ботов (3× от количества товаров), которые будут:
- Делать ставки с разной агрессивностью
- Перебивать друг друга
- Снайпить в конце раунда (не более 2 раз на бота)

## API

### Аутентификация

```
POST /api/auth/login    { username }
GET  /api/auth/me
POST /api/auth/logout
```

### Аукционы

```
GET  /api/auctions
POST /api/auctions      { title, totalItems, startingPrice, roundsConfig, createdBy }
POST /api/auctions/:id/start   { enableBotSimulation?, botCount? }
GET  /api/auctions/:id
GET  /api/auctions/:id/leaderboard
GET  /api/auctions/:id/winners
```

### Ставки

```
POST /api/auctions/:id/bid        { userId, amount }
POST /api/auctions/:id/quick-bid  { userId, type: "outbid" }
GET  /api/auctions/:id/user/:userId/status
```

### Баланс

```
GET  /api/users/:id/balance
POST /api/users/:id/deposit  { amount }
```

## WebSocket

```javascript
// Подключение к аукциону
socket.emit('auction:join', auctionId);

// События
socket.on('auction:new_bid', ({ auctionId, bid, minWinningBid }) => {});
socket.on('auction:leaderboard', ({ auctionId, leaderboard }) => {});
socket.on('auction:time_extended', ({ auctionId, newEndTime }) => {});
socket.on('auction:event', ({ type, auctionId, roundNumber, data }) => {});
```

## Переменные окружения

```
PORT=80
MONGODB_URI=mongodb://mongo:27017/auction_db?replicaSet=rs0
REDIS_URI=redis://redis:6379
ANTI_SNIPE_THRESHOLD_MS=30000
ANTI_SNIPE_EXTENSION_MS=60000
MIN_BID_INCREMENT=10
```

## Структура проекта

```
src/
├── controllers/    Обработчики HTTP-запросов
├── services/       Бизнес-логика
├── models/         Mongoose-схемы
├── websocket/      Socket.IO
├── middleware/     Auth, error handling
└── config/         Конфигурация

public/             Статика (фронтенд)
```
