FROM node:20-alpine

WORKDIR /app

# Устанавливаем tsx глобально для запуска скриптов
RUN npm install -g tsx

COPY package*.json ./

# Устанавливаем все зависимости (включая dev для сборки)
RUN npm ci

COPY . .

# Собираем TypeScript
RUN npm run build

EXPOSE 3000

# tsx остаётся для запуска скриптов (bots, load-test, seed)
CMD ["npm", "start"]
