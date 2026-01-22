/**
 * Создание тестовых данных для разработки и демонстрации.
 * 
 * Использование: npm run seed
 */

import mongoose from 'mongoose';
import { config } from '../src/config';
import { User, Auction } from '../src/models';
import { userService, auctionService } from '../src/services';
import { logger } from '../src/utils/logger';

async function seed() {
  logger.info('Запуск seed...');

  await mongoose.connect(config.mongodb.uri);
  logger.info('Подключено к MongoDB');

  // Чистим старые данные
  await User.deleteMany({});
  await Auction.deleteMany({});
  await mongoose.connection.collection('bids').deleteMany({});
  await mongoose.connection.collection('transactions').deleteMany({});
  logger.info('Старые данные удалены');

  // Создаём админа
  const admin = await userService.createUser('admin', 1000000);
  logger.info(`Создан админ: ${admin.id}`);

  // Тестовые пользователи
  const testUsers = [];
  for (let i = 1; i <= 10; i++) {
    const user = await userService.createUser(`user${i}`, 50000);
    testUsers.push(user);
  }
  logger.info(`Создано ${testUsers.length} тестовых пользователей`);

  // Демо-аукцион
  const demoAuction = await auctionService.createAuction({
    title: 'Лимитированные цифровые бейджи',
    description: 'Эксклюзивные коллекционные предметы с уникальными номерами. Многораундовый аукцион на 100 товаров.',
    totalItems: 100,
    startingPrice: 100,
    minBidIncrement: 10,
    roundsConfig: [
      { itemsToDistribute: 30, durationMs: 120000 }, // 2 мин
      { itemsToDistribute: 30, durationMs: 120000 },
      { itemsToDistribute: 40, durationMs: 180000 }, // 3 мин
    ],
    startTime: new Date(Date.now() + 5000), // старт через 5 сек
    createdBy: admin._id as mongoose.Types.ObjectId,
  });
  logger.info(`Создан демо-аукцион: ${demoAuction.id}`);

  // Быстрый аукцион для тестов
  const quickAuction = await auctionService.createAuction({
    title: 'Быстрый тест',
    description: 'Короткий аукцион для проверки.',
    totalItems: 10,
    startingPrice: 50,
    minBidIncrement: 5,
    roundsConfig: [
      { itemsToDistribute: 3, durationMs: 30000 },
      { itemsToDistribute: 3, durationMs: 30000 },
      { itemsToDistribute: 4, durationMs: 30000 },
    ],
    startTime: new Date(Date.now() + 3000),
    createdBy: admin._id as mongoose.Types.ObjectId,
  });
  logger.info(`Создан быстрый аукцион: ${quickAuction.id}`);

  console.log('\n=== Seed завершён ===');
  console.log('Тестовые данные:');
  console.log('  Админ: admin (баланс: 1,000,000)');
  console.log('  Пользователи: user1-user10 (баланс: 50,000 каждый)');
  console.log('');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  logger.error('Ошибка seed:', err);
  process.exit(1);
});
