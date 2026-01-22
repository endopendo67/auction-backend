import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
  },
  
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/auction_db',
  },
  
  auction: {
    defaultRoundDurationMs: parseInt(process.env.DEFAULT_ROUND_DURATION_MS || '300000', 10),
    antiSnipeThresholdMs: parseInt(process.env.ANTI_SNIPE_THRESHOLD_MS || '30000', 10),
    antiSnipeExtensionMs: parseInt(process.env.ANTI_SNIPE_EXTENSION_MS || '60000', 10),
    minBidIncrement: parseInt(process.env.MIN_BID_INCREMENT || '10', 10),
  },
  
  logging: {
    level: process.env.LOG_LEVEL || 'debug',
  },
} as const;

export type Config = typeof config;
