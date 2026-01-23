# Telegram Gift Auctions

Многораундовая аукционная система по типу Telegram Gift Auctions.

**[Live Demo →](https://auction-demo.lol)**

---

## Быстрый старт

```bash
git clone https://github.com/endopendo67/auction-backend.git
cd auction-backend
docker-compose up -d
```

Открыть http://localhost

---

## Как использовать

1. **Войдите** — введите любой username
2. **Создайте аукцион** — настройте раунды и товары
3. **Включите симуляцию** — боты начнут торговаться
4. **Делайте ставки** — перебивайте ботов и других игроков

### Симуляция торгов

При создании аукциона включите переключатель "Симуляция торгов":
- Боты автоматически ставят и перебивают
- Снайпят в последние 30 секунд (макс 2 раза на бота)
- Количество ботов = 3× от товаров

---

## Архитектура

```
Frontend (HTML/JS) ←→ Backend (Express + WebSocket) ←→ MongoDB + Redis
```

### Ключевые фичи

- **Real-time** — лидерборд обновляется мгновенно (WebSocket)
- **Anti-sniping** — ставка в последние 30 сек продлевает раунд
- **Атомарные операции** — без транзакций, без WriteConflict
- **Многораундовость** — топ-N получают товар, остальные → следующий раунд

---

## Как работает

### Раунды

```
Раунд 1: топ-3 → получают товар
Раунд 2: топ-3 → получают товар  
Раунд 3: топ-4 → получают товар, остальные → возврат
```

### Финансы

```
Ставка 1000   → блокируем 1000
Повышаем 1500 → блокируем +500 (разницу)
Выигрыш       → списываем
Проигрыш      → разблокируем
```

---

## Стек

- Node.js + TypeScript + Express
- MongoDB (replica set) + Redis
- Socket.IO для real-time
- Zod для валидации

---

## API

```
POST /api/auth/login         { username }
GET  /api/auctions
POST /api/auctions           { title, totalItems, startingPrice, roundsConfig }
POST /api/auctions/:id/start { enableBotSimulation, botCount }
POST /api/auctions/:id/bid   { userId, amount }
GET  /api/auctions/:id/leaderboard
```

### WebSocket

```javascript
socket.emit('auction:join', auctionId);
socket.on('auction:new_bid', (data) => {});
socket.on('auction:leaderboard', (data) => {});
socket.on('auction:time_extended', (data) => {});
```

---

## Конфигурация

| Переменная | Default | Описание |
|------------|---------|----------|
| PORT | 80 | Порт сервера |
| MONGODB_URI | mongodb://mongo:27017/auction_db | MongoDB |
| REDIS_URI | redis://redis:6379 | Redis |
| ANTI_SNIPE_THRESHOLD_MS | 30000 | Окно anti-sniping |
| ANTI_SNIPE_EXTENSION_MS | 60000 | Продление раунда |

---

## Структура

```
src/
├── services/           # bid, auction, balance, round-manager, bot-simulator
├── controllers/        # HTTP endpoints
├── websocket/          # Socket.IO
├── models/             # User, Auction, Bid, Transaction
└── middleware/         # auth, errors

public/                 # Frontend (HTML/CSS/JS)
```
