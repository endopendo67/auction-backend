# Auction Backend

Multi-round auction system with real-time bidding, anti-sniping, and bot simulation.

## Demo

https://auction-demo.lol

## Quick Start

```bash
docker-compose up -d
```

App runs on port 80. MongoDB and Redis are included.

## Core Features

**Multi-round auctions** — configurable rounds with different item counts and durations. Top N bidders win items each round, losers carry over to next round.

**Real-time updates** — WebSocket pushes for bids, leaderboard changes, and time extensions. No polling required.

**Anti-sniping** — bids in last 30 seconds extend round by 60 seconds. Configurable via env vars.

**Bot simulation** — toggle in UI spawns bots (3× item count) that bid, outbid, and snipe (max 2 snipes per bot).

**Atomic operations** — no transactions, no WriteConflict. All balance operations use `findOneAndUpdate` with conditions.

## Architecture

```
Express + Socket.IO → MongoDB (replica set) + Redis (cache + rate limit)
```

Bid flow:
1. Validate amount and auction state
2. Atomically lock funds: `User.findOneAndUpdate({ balance >= amount }, { $inc: lockedBalance })`
3. Create/update bid
4. Broadcast via WebSocket
5. On round end: winners charged, losers refunded (batch operations)

## API

```
POST /api/auth/login              { username }
POST /api/auctions                { title, totalItems, startingPrice, roundsConfig, startTime, createdBy }
POST /api/auctions/:id/start      { enableBotSimulation?, botCount? }
POST /api/auctions/:id/bid        { userId, amount }
POST /api/auctions/:id/quick-bid  { userId, type: "outbid" }
GET  /api/auctions/:id/leaderboard
GET  /api/auctions/:id/winners
```

WebSocket events: `auction:join`, `auction:new_bid`, `auction:leaderboard`, `auction:time_extended`, `auction:event`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 80 | Server port |
| MONGODB_URI | mongodb://mongo:27017/auction_db?replicaSet=rs0 | Replica set required for change streams |
| REDIS_URI | redis://redis:6379 | Optional, falls back to in-memory |
| ANTI_SNIPE_THRESHOLD_MS | 30000 | Bid within this window triggers extension |
| ANTI_SNIPE_EXTENSION_MS | 60000 | How much to extend |
| MIN_BID_INCREMENT | 10 | Minimum raise amount |

## Project Structure

```
src/
  services/
    auction.service.ts      # CRUD, round transitions
    bid.service.ts          # Place bids, process winners, leaderboard
    bot-simulator.service.ts # Automated bidding bots
    round-manager.service.ts # Timer-based round completion
    redis.service.ts        # Caching layer
  controllers/              # Express routes
  websocket/                # Socket.IO handlers
  models/                   # Mongoose schemas (User, Auction, Bid, Transaction)

public/                     # Vanilla JS frontend
```

## Key Implementation Details

**Balance locking** — on bid, funds move to `lockedBalance`. On win, both `balance` and `lockedBalance` decrease. On loss, only `lockedBalance` decreases. Atomic, no race conditions.

**Leaderboard** — sorted by `{ amount: -1, createdAt: 1 }`. Cached in Redis for 2 seconds. Composite index for performance.

**Round manager** — runs every second, checks active auctions for round completion. Uses event emitter to notify WebSocket handler.

**Bot personalities** — aggressive (fast, high bids), cautious (slow, low max), sniper (waits for end), random. Each has configurable think time, bid multiplier, snipe chance.

## Development

```bash
npm install
npm run dev     # ts-node-dev with hot reload
npm run build   # TypeScript compile
npm start       # Production
```

Requires MongoDB with replica set (for `findOneAndUpdate` with `$expr`) and optionally Redis.
