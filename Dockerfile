FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src ./src
COPY tsconfig.json ./

RUN npm run build

# Production
FROM node:20-alpine

WORKDIR /app

RUN npm install -g tsx

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/server.js"]
