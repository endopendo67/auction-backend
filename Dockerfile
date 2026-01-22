FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# Устанавливаем все зависимости (включая dev для сборки)
RUN npm ci

COPY . .

# Собираем TypeScript
RUN npm run build

# Удаляем devDependencies после сборки
RUN npm prune --production

EXPOSE 3000

CMD ["npm", "start"]
