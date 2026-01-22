# Проект для конкурса [CryptoBot Backend Challenge]

Воспроизведение механики аукционов Telegram на лимитированные цифровые подарки.

**🌐 Демо:** [auction-demo.lol](https://auction-demo.lol) &nbsp;|&nbsp; **🎬 Видео:** [Streamable](https://streamable.com/cl5w2s)

---

## Что внутри

Это не классический аукцион с одним дедлайном. Тут **многораундовая система**:

- Аукцион разбит на несколько раундов
- В каждом раунде часть участников получает товар
- Остальные автоматически переходят в следующий раунд
- Есть защита от снайперских ставок в последнюю секунду

---

## Быстрый старт

### Docker (рекомендуется)

```bash
git clone https://github.com/endopendo67/auction-backend.git
cd auction-backend
docker-compose up -d
```

Готово. Открывай http://localhost:3000

Docker поднимет MongoDB (с replica set для транзакций), Redis и само приложение.

### Без Docker

```bash
# MongoDB с replica set (для транзакций)
brew services start mongodb-community
mongosh --eval "rs.initiate()"

# Опционально: Redis
brew services start redis

# Приложение
npm install
cp env.example .env
npm run dev
```

---

## Технологии

| Что | Зачем |
|-----|-------|
| **Node.js + TypeScript** | Основной стек по условиям конкурса |
| **MongoDB** | Хранение данных + транзакции (snapshot isolation) |
| **Redis** | Кэширование лидерборда, rate limiting |
| **Socket.IO** | Real-time обновления ставок |
| **Zod** | Валидация входных данных |

---

## Механика аукциона

### Многораундовая система

```
Раунд 1: 100 товаров → топ-100 ставок выигрывают
         остальные переносятся в раунд 2

Раунд 2: 50 товаров → топ-50 выигрывают
         остальные → раунд 3

Раунд 3: 50 товаров → топ-50 выигрывают
         остальные → возврат средств
```

### Ранжирование ставок

1. По сумме (больше = выше)
2. При равных суммах — кто раньше поставил

### Anti-Sniping

Ставка в последние **30 секунд** продлевает раунд на **60 секунд**.

Это не даёт выиграть просто поставив в последнюю миллисекунду.

---

## Финансовая корректность

Это главное. Деньги не должны теряться и не должны дублироваться.

### Как работает

```
Ставка 1000 ⭐   →  Блокируем 1000 (balance не меняется, lockedBalance += 1000)
Повышаем до 1500 →  Блокируем ещё 500 (только разницу)
Выигрыш          →  Списываем 1500 (balance -= 1500, lockedBalance -= 1500)
Проигрыш         →  Возвращаем (lockedBalance -= 1500, balance не меняется)
```

### Защиты

**Атомарные операции** — никакой race condition не сломает баланс:

```typescript
await User.updateOne(
  {
    _id: userId,
    // Проверка И обновление в одной операции
    $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, amount] }
  },
  { $inc: { lockedBalance: amount } },
  { session }
);
```

**Транзакции MongoDB** — snapshot isolation, все операции или выполняются, или откатываются.

**Retry с backoff** — при конфликте записи повторяем до 5 раз с экспоненциальной задержкой.

**Аудит** — каждая операция с деньгами логируется в коллекцию `Transaction`.

---

## Edge Cases

Обработаны пограничные случаи:

| Случай | Решение |
|--------|---------|
| Ставка на границе времени | Буфер 100мс до конца раунда |
| Спам ставками | Rate limit: 10 ставок / 5 сек (Redis) |
| Нет участников в раунде | Раунд завершается без победителей |
| Участников меньше чем товаров | Все выигрывают |
| Равные ставки | Выигрывает кто раньше поставил |
| Слишком большая сумма | Лимит 1 млрд |
| Переполнение баланса | Лимит 10 млрд |

---

## Оптимизации

### База данных

- **Составной индекс** для лидерборда: `{ auctionId, status, amount, createdAt }`
- **Lean queries** где не нужны методы документа
- **Projection** — запрашиваем только нужные поля

### Кэширование (Redis)

- Лидерборд — TTL 2 сек
- Минимальная выигрышная ставка — TTL 1 сек
- Инвалидация после каждой ставки

### WebSocket

- Throttling лидерборда — не чаще 200мс
- Отдельные комнаты для каждого аукциона
- Lobby для списка аукционов

---

## Тестирование

```bash
# Тестовые данные
npm run seed

# 50 ботов с разными стратегиями (киты, снайперы, осторожные)
npx tsx scripts/bots.ts

# Нагрузочный тест
npx tsx scripts/load-test.ts --bots=100
npx tsx scripts/load-test.ts --bots=1000 --duration=120000

# Стресс-тест (5000+ ботов)
npm run test:stress
npx tsx scripts/stress-test.ts --bots=10000 --rps=500
```

Тесты проверяют:
- RPS и latency (Avg, P50, P95, P99)
- Пиковую конкурентность
- **Целостность балансов** — что деньги сходятся после всех операций

---

## API

### REST

```
POST /api/auth/login          { username }
GET  /api/auth/me
POST /api/auth/logout

GET  /api/auctions
POST /api/auctions            { title, totalItems, startingPrice, roundsConfig, ... }
GET  /api/auctions/:id
POST /api/auctions/:id/start
POST /api/auctions/:id/bid    { userId, amount }
GET  /api/auctions/:id/leaderboard
GET  /api/auctions/:id/winners

GET  /api/users/:id/balance
POST /api/users/:id/deposit   { amount }
```

### WebSocket

```javascript
socket.emit('auction:join', auctionId);
socket.emit('lobby:join');

socket.on('auction:new_bid', (data) => { /* обновить UI */ });
socket.on('auction:time_extended', (data) => { /* anti-snipe сработал */ });
socket.on('auction:leaderboard', (data) => { /* push лидерборда */ });
socket.on('lobby:new_auction', (data) => { /* новый аукцион */ });
```

---

## Структура проекта

```
src/
├── services/
│   ├── bid.service.ts       # Ставки, retry, rate limiting
│   ├── balance.service.ts   # Финансы, транзакции
│   ├── auction.service.ts   # Создание, запуск, anti-snipe
│   ├── redis.service.ts     # Кэш, rate limit
│   └── round-manager.service.ts  # Автоматическое завершение раундов
├── models/                  # User, Auction, Bid, Transaction
├── controllers/             # HTTP handlers
├── websocket/               # Socket.IO
└── middleware/              # Auth, error handling

scripts/
├── seed.ts          # Тестовые данные
├── bots.ts          # Симуляция 50 пользователей
├── load-test.ts     # До 1000 ботов
└── stress-test.ts   # 5000+ ботов, проверка под нагрузкой
```

---

## Конфиг

| Переменная | Описание | Default |
|------------|----------|---------|
| `PORT` | Порт сервера | 3000 |
| `MONGODB_URI` | MongoDB connection string | mongodb://localhost:27017/auction_db |
| `REDIS_URI` | Redis (опционально) | redis://localhost:6379 |
| `ANTI_SNIPE_THRESHOLD_MS` | Порог для anti-snipe | 30000 |
| `ANTI_SNIPE_EXTENSION_MS` | На сколько продлевать | 60000 |
| `MIN_BID_INCREMENT` | Минимальный шаг ставки | 10 |

---

## Что можно улучшить

- [ ] Горизонтальное масштабирование (Redis pub/sub для синхронизации WS между инстансами)
- [ ] Очереди для тяжёлых операций (Bull/BullMQ)
- [ ] Метрики (Prometheus + Grafana)
- [ ] E2E тесты

---

Сделано для [CryptoBot Backend Challenge](https://t.me/CryptoBotRU) 🚀
