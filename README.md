# ⭐ Auction Platform

Аукционная система с real-time торгами. Работает как CS:GO лотереи — несколько раундов, в каждом топ участников забирает товар.

**🌐 [Демо](https://auction-demo.lol)**

---

## Быстрый старт

```bash
git clone https://github.com/endopendo67/auction-backend.git
cd auction-backend
docker-compose up -d
```

Готово. Открывай http://localhost

---

## Как это работает

### Механика аукциона

Допустим, у тебя 10 товаров и 3 раунда:

```
┌─────────────────────────────────────────────────────┐
│ Раунд 1 │ 2 минуты │ Топ-3 получают товар          │
│ Раунд 2 │ 90 сек   │ Топ-3 получают товар          │
│ Раунд 3 │ 1 минута │ Топ-4 получают последние      │
└─────────────────────────────────────────────────────┘
```

Не попал в топ? Деньги вернутся. Ставка выше = позиция лучше.

### Anti-sniping

Кто-то ставит за 5 секунд до конца? Раунд продлится на минуту. Но только с шансом 50% и один раз за раунд — чтобы не затягивать до бесконечности.

### Баланс

| Что делаешь | Что происходит |
|-------------|----------------|
| Ставишь 100⭐ | 100⭐ блокируется |
| Повышаешь до 150⭐ | Блокируется ещё 50⭐ |
| Выиграл | 150⭐ списывается |
| Проиграл | 150⭐ возвращается |

---

## Запуск тестов

### Симуляция торгов (рекомендую)

1. Открой демо
2. Создай аукцион
3. Включи галочку "Симуляция торгов"
4. Смотри как 30 ботов торгуются

### Стресс-тест

```bash
docker-compose exec app npx tsx scripts/stress-test.ts
```

5000 товаров, 6000 ботов, ~300 запросов в секунду. Если всё ок — увидишь success rate близкий к 100%.

### Тестовые данные

```bash
docker-compose exec app npx tsx scripts/seed.ts
```

Создаст админа с миллионом звёзд и 10 тестовых юзеров.

---

## API

### Вход

```http
POST /api/auth/login
{
  "username": "player1"
}
```

Если юзера нет — создастся с балансом 10,000⭐

### Создать аукцион

```http
POST /api/auctions
{
  "title": "NFT Drop",
  "totalItems": 10,
  "startingPrice": 100,
  "roundsConfig": [
    { "itemsToDistribute": 3, "durationMs": 120000 },
    { "itemsToDistribute": 3, "durationMs": 90000 },
    { "itemsToDistribute": 4, "durationMs": 60000 }
  ],
  "createdBy": "user_id"
}
```

### Поставить ставку

```http
POST /api/auctions/:id/bid
{
  "userId": "user_id",
  "amount": 500
}
```

### Лидерборд

```http
GET /api/auctions/:id/leaderboard?limit=100
```

---

## WebSocket

```javascript
const socket = io({ transports: ['websocket'] });

socket.emit('auction:join', auctionId);

socket.on('auction:leaderboard', (data) => {
  // Обновляй таблицу
});

socket.on('auction:new_bid', (data) => {
  // Новая ставка, обнови минимальную
});
```

### События

| Event | Когда приходит |
|-------|----------------|
| `auction:joined` | Подключился к аукциону |
| `auction:leaderboard` | Лидерборд обновился |
| `auction:winners` | Победители (для завершённых) |
| `auction:new_bid` | Кто-то сделал ставку |
| `auction:time_extended` | Сработал anti-sniping |
| `auction:event` | Раунд начался/закончился |

---

## Структура

```
src/
├── controllers/     # Обработка HTTP запросов
├── services/        # Вся логика тут
│   ├── bid.service.ts
│   ├── auction.service.ts
│   ├── balance.service.ts
│   └── bot-simulator.service.ts
├── models/          # MongoDB схемы
├── websocket/       # Real-time обновления
└── routes/          # Эндпоинты

public/              # Фронт (vanilla JS)
scripts/             # seed.ts, stress-test.ts
```

---

## Конфигурация

```bash
# .env
PORT=80
MONGODB_URI=mongodb://mongo:27017/auction_db?replicaSet=rs0
REDIS_URI=redis://redis:6379

# Anti-sniping
ANTI_SNIPE_THRESHOLD_MS=30000   # Последние 30 сек
ANTI_SNIPE_EXTENSION_MS=60000   # Продление на 1 мин
```

---

## Технологии

- **Node.js + TypeScript** — бэкенд
- **MongoDB** — база данных (с replica set для транзакций)
- **Redis** — кэш лидерборда
- **Socket.IO** — real-time
- **Docker Compose** — всё в контейнерах

---

## Частые вопросы

**Зачем replica set для MongoDB?**

Чтобы работали атомарные операции. Без него нельзя гарантировать что баланс не уйдёт в минус при параллельных ставках.

**Можно без Docker?**

Можно, но придётся вручную поднять MongoDB (с `--replSet rs0`) и Redis. Потом `npm install && npm run dev`.

**Как добавить больше ботов?**

В `app.js` при создании аукциона бот-каунт считается как `totalItems * 3`. Поменяй множитель.

---

## Лицензия

MIT. Делай что хочешь.
