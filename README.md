# Auction Platform

Многораундовая аукционная система для распределения цифровых товаров с real-time обновлениями через WebSocket.

**[Live Demo →](https://auction-demo.lol)**

---

## Установка и запуск

### Требования

- Docker и Docker Compose
- Порты 80, 27017, 6379 (или используйте `docker-compose.host.yml`)

### Быстрый старт

```bash
git clone https://github.com/endopendo67/auction-backend.git
cd auction-backend
docker-compose up -d
```

Приложение доступно на **http://localhost**

### Проверка статуса

```bash
docker-compose ps
```

Все сервисы должны быть в состоянии `Up (healthy)`:
- `auction-app` — основное приложение
- `auction-mongo` — MongoDB с replica set
- `auction-redis` — Redis для кэширования

### Просмотр логов

```bash
docker-compose logs -f app
```

### Остановка

```bash
docker-compose down
```

---

## Инструкция по тестированию

### 1. Базовый сценарий (5 минут)

```bash
# Запустить приложение
docker-compose up -d

# Открыть в браузере
# http://localhost

# 1. Войти под любым username
#    Начальный баланс: 10,000 ⭐

# 2. Создать аукцион:
#    - Название: "Тестовый аукцион"
#    - Товаров: 10
#    - Начальная цена: 100
#    - 3 раунда (любая длительность)
#    - ✓ Включить "Симуляция торгов"

# 3. Наблюдать:
#    - Боты начинают ставить (3× количества товаров = 30 ботов)
#    - Лидерборд обновляется в реальном времени
#    - Можно самому сделать ставку или перебить
```

### 2. Проверка anti-sniping

```bash
# 1. Создать аукцион с коротким раундом (60 сек)
# 2. Включить симуляцию
# 3. За 30 секунд до конца — сделать ставку
# 4. Проверить: раунд продлится с шансом 50%
#    (максимум 1 продление за раунд)
```

### 3. Стресс-тест (6000 ботов, 5000 товаров)

```bash
docker-compose exec -T app npx tsx scripts/stress-test.ts
```

**Что тестируется:**
- 5000 товаров, 5 раундов по 30 секунд
- 6000 ботов делают ставки параллельно
- ~300 запросов в секунду
- Проверка целостности балансов

**Ожидаемый результат:**
- Success rate: ~100%
- Avg latency: <100ms
- Нет ошибок баланса

### 4. Тестовые данные

```bash
docker-compose exec -T app npx tsx scripts/seed.ts
```

Создаёт:
- Пользователя `admin` с балансом 1,000,000
- 10 тестовых пользователей по 50,000
- Демо-аукционы

---

## Описание системы

### Многораундовая механика

Аукцион делится на раунды. В каждом раунде топ-N участников получают товар.

**Пример:** 10 товаров, 3 раунда
```
Раунд 1 (120 сек) → топ-3 получают товар
Раунд 2 (90 сек)  → топ-3 получают товар
Раунд 3 (60 сек)  → топ-4 получают товар
                     остальные → возврат средств
```

### Ранжирование

1. **По сумме ставки** — чем выше, тем лучше позиция
2. **По времени** — при равных ставках кто раньше, тот выше
3. Повышение ставки сохраняет исходное время

### Anti-sniping

**Условие:** Ставка в последние 30 секунд раунда

**Эффект:**
- Раунд продлевается на 60 секунд
- Шанс срабатывания: 50%
- Максимум 1 продление за раунд

**Цель:** Предотвратить тактику "ставка в последнюю секунду"

### Финансовая модель

| Действие | Баланс | Заблокировано |
|----------|--------|---------------|
| Новая ставка 100⭐ | — | +100⭐ |
| Повышение до 150⭐ | — | +50⭐ |
| Выигрыш | -150⭐ | -150⭐ |
| Проигрыш | — | -150⭐ |

**Ключевая особенность:** Все операции атомарны. Используется `findOneAndUpdate` с условиями в фильтре вместо транзакций — это исключает WriteConflict при высокой нагрузке.

---

## Технологии

| Компонент | Технология |
|-----------|------------|
| Backend | Node.js 20, TypeScript 5.3, Express 4 |
| Database | MongoDB 7 (ReplicaSet) |
| Cache | Redis 7 |
| Real-time | Socket.IO 4 |
| Validation | Zod |

---

## API

### Аутентификация

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "player1",
  "initialBalance": 10000
}
```

### Создание аукциона

```http
POST /api/auctions
Content-Type: application/json

{
  "title": "NFT Аукцион",
  "totalItems": 10,
  "startingPrice": 100,
  "roundsConfig": [
    { "itemsToDistribute": 3, "durationMs": 120000 },
    { "itemsToDistribute": 3, "durationMs": 90000 },
    { "itemsToDistribute": 4, "durationMs": 60000 }
  ],
  "startTime": "2024-01-01T12:00:00Z",
  "createdBy": "user_id"
}
```

### Запуск с ботами

```http
POST /api/auctions/:id/start
Content-Type: application/json

{
  "enableBotSimulation": true,
  "botCount": 30
}
```

### Размещение ставки

```http
POST /api/auctions/:id/bid
Content-Type: application/json

{
  "userId": "user_id",
  "amount": 500
}
```

### Лидерборд

```http
GET /api/auctions/:id/leaderboard?limit=100
```

**Response:**
```json
{
  "success": true,
  "data": [
    { "position": 1, "amount": 1500, "username": "player1", "status": "active" },
    { "position": 2, "amount": 1200, "username": "player2", "status": "active" }
  ]
}
```

---

## WebSocket Events

### Подключение

```javascript
const socket = io({ transports: ['websocket', 'polling'] });

// Присоединиться к аукциону
socket.emit('auction:join', auctionId);
```

### События от сервера

| Event | Payload | Описание |
|-------|---------|----------|
| `auction:joined` | `{ auctionId, auction, roundInfo, minWinningBid }` | Подтверждение подключения |
| `auction:new_bid` | `{ auctionId, bid, minWinningBid }` | Новая ставка |
| `auction:leaderboard` | `{ auctionId, leaderboard[] }` | Обновление лидерборда |
| `auction:time_extended` | `{ auctionId, newEndTime, extensionCount }` | Продление времени |
| `auction:event` | `{ type, auctionId, roundNumber, data }` | События раунда |

**Типы событий:**
- `round_started` — раунд начался
- `round_ending_soon` — за 30 сек до конца
- `round_ended` — раунд завершён
- `auction_completed` — аукцион завершён

---

## Переменные окружения

```bash
# Сервер
PORT=80
NODE_ENV=production

# База данных
MONGODB_URI=mongodb://mongo:27017/auction_db?replicaSet=rs0
REDIS_URI=redis://redis:6379

# Аукцион
DEFAULT_ROUND_DURATION_MS=300000
ANTI_SNIPE_THRESHOLD_MS=30000
ANTI_SNIPE_EXTENSION_MS=60000
MIN_BID_INCREMENT=10

# Логи
LOG_LEVEL=info
```

---

## Структура проекта

```
auction-backend/
├── src/
│   ├── controllers/       # HTTP handlers
│   │   ├── auction.controller.ts
│   │   ├── auth.controller.ts
│   │   └── user.controller.ts
│   ├── services/          # Бизнес-логика
│   │   ├── auction.service.ts
│   │   ├── bid.service.ts
│   │   ├── balance.service.ts
│   │   ├── bot-simulator.service.ts
│   │   ├── round-manager.service.ts
│   │   └── redis.service.ts
│   ├── models/            # Mongoose схемы
│   │   ├── auction.model.ts
│   │   ├── bid.model.ts
│   │   ├── user.model.ts
│   │   └── transaction.model.ts
│   ├── websocket/         # Socket.IO handler
│   │   └── socket-handler.ts
│   ├── middleware/        # Auth, error handling
│   ├── routes/            # Express роуты
│   └── locales/           # Переводы (ru, en)
├── public/                # Frontend SPA
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── scripts/               # Вспомогательные скрипты
│   ├── seed.ts           # Тестовые данные
│   └── stress-test.ts    # Нагрузочное тестирование
└── docker-compose.yml     # Оркестрация контейнеров
```

---

## Особенности реализации

### Атомарные операции

Вместо MongoDB транзакций используются атомарные операции с условиями:

```typescript
// Блокировка средств (один запрос)
await User.findOneAndUpdate(
  {
    _id: userId,
    $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, amount] }
  },
  { $inc: { lockedBalance: amount } }
);
```

**Преимущества:**
- Нет WriteConflict
- Выше производительность
- Проще код

### Batch обработка победителей

```typescript
// Один bulkWrite для всех обновлений
await User.bulkWrite(userUpdates, { ordered: false });
await Bid.bulkWrite(bidUpdates, { ordered: false });
```

### Индексы MongoDB

```javascript
// Оптимизация лидерборда
{ auctionId: 1, status: 1, amount: -1, createdAt: 1 }
```

---

## FAQ

**Q: Можно запустить без Docker?**

A: Да, но нужно вручную поднять MongoDB с replica set и Redis:
```bash
# MongoDB
mongod --replSet rs0

# Redis
redis-server

# App
npm install
cp env.example .env
npm run dev
```

**Q: Как увеличить количество ботов?**

A: Измените расчёт в `handleCreateAuction()`:
```javascript
const botCount = totalItems * 5; // Было 3x
```

**Q: Как отключить anti-sniping?**

A: Установите в `.env`:
```
ANTI_SNIPE_THRESHOLD_MS=0
```
