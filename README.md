# Auction Backend

> Проект для конкурса [CryptoBot Backend Challenge](https://t.me/CryptoBotRU)

Бэкенд аукционной системы по типу Telegram Gift Auctions.

🌐 **Live-демо:** [auction-demo.lol](https://auction-demo.lol)

## Быстрый старт (Docker)

```bash
# Клонируем и запускаем
git clone <repo>
cd auction-backend
docker-compose up -d

# Открываем http://localhost:3000
```

Docker-compose поднимает MongoDB с replica set (нужен для транзакций) и приложение. Всё настроено автоматически.

### Запуск скриптов в Docker

```bash
# Тестовые данные
docker-compose exec app npm run seed

# Боты (50 штук с реалистичным поведением)
docker-compose exec app tsx scripts/bots.ts

# Нагрузочный тест (100 ботов)
docker-compose exec app tsx scripts/load-test.ts --bots=100

# Нагрузочный тест (1000 ботов)
docker-compose exec app tsx scripts/load-test.ts --bots=1000 --duration=120000
```

## Локальный запуск (без Docker)

### 1. MongoDB с replica set

MongoDB должен работать с replica set для поддержки транзакций:

```bash
# macOS
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community

# Инициализация replica set
mongosh --eval "rs.initiate()"
```

### 2. Приложение

```bash
npm install
cp env.example .env
npm run dev
```

Откроется на http://localhost:3000

### 3. Тестовые данные (опционально)

```bash
npm run seed
```

Создаст админа, тестовых юзеров и пару аукционов для демонстрации.

## Как работает аукцион

1. **Многораундовая система** — аукцион разбит на раунды. В каждом раунде топ-N ставок получают товар.

2. **Ранжирование** — по сумме ставки, при равных суммах — кто раньше поставил.

3. **Перенос ставок** — кто не выиграл, переходит в следующий раунд с той же ставкой.

4. **Anti-sniping** — ставка в последние 30 секунд продлевает раунд на 60 секунд.

5. **Работа с деньгами**:
   - Ставка → средства блокируются
   - Повышение → блокируется разница
   - Выигрыш → списание
   - Проигрыш в последнем раунде → возврат

## Конкурентность и финансы

- Все операции с деньгами через **транзакции MongoDB** (snapshot isolation)
- **Атомарные проверки** баланса через `$expr` + `$inc`
- **Retry с backoff** при WriteConflict
- **Аудит** — каждая операция логируется в Transaction

```typescript
// Пример атомарной блокировки средств
await User.updateOne(
  {
    _id: userId,
    $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, amount] }
  },
  { $inc: { lockedBalance: amount } },
  { session }
);
```

## API

### Авторизация
```
POST /api/auth/login     — { username } → ставит куку
POST /api/auth/logout    — выход
GET  /api/auth/me        — текущий пользователь
```

### Аукционы
```
GET  /api/auctions              — список
POST /api/auctions              — создать
GET  /api/auctions/:id          — детали
POST /api/auctions/:id/start    — запустить
POST /api/auctions/:id/bid      — ставка { userId, amount }
GET  /api/auctions/:id/leaderboard
```

### Баланс
```
GET  /api/users/:id/balance
POST /api/users/:id/deposit     — { amount }
```

### WebSocket
```javascript
socket.emit('auction:join', auctionId);
socket.on('auction:new_bid', (data) => { });
socket.on('auction:time_extended', (data) => { });
socket.on('auction:event', (event) => { });
```

## Тестирование

### Боты

```bash
npx tsx scripts/bots.ts
```

Запускает 8 ботов с разными стратегиями — агрессивные, терпеливые, снайперы.

### Нагрузочный тест

```bash
# 100 ботов
npx tsx scripts/load-test.ts --bots=100

# 1000 ботов на 2 минуты
npx tsx scripts/load-test.ts --bots=1000 --duration=120000
```

Результат показывает:
- RPS и время ответа
- Пиковую конкурентность
- **Проверку целостности балансов** — что деньги сходятся

## Структура

```
src/
├── controllers/    — HTTP хендлеры
├── services/       — бизнес-логика
│   ├── balance.service.ts   — работа с деньгами
│   ├── bid.service.ts       — ставки с retry
│   ├── auction.service.ts   — управление аукционами
│   └── round-manager.service.ts — логика раундов
├── models/         — User, Auction, Bid, Transaction
├── websocket/      — real-time обновления
└── ...

scripts/
├── seed.ts         — тестовые данные
├── bots.ts         — симуляция пользователей
└── load-test.ts    — нагрузка до 1000 ботов
```

## Конфиг

| Переменная | Описание | Default |
|------------|----------|---------|
| PORT | Порт | 3000 |
| MONGODB_URI | MongoDB URI | mongodb://localhost:27017/auction_db |
| ANTI_SNIPE_THRESHOLD_MS | Порог anti-snipe | 30000 |
| ANTI_SNIPE_EXTENSION_MS | Продление | 60000 |

## Языки

RU / EN — переключатель в хедере, сохраняется в localStorage.
