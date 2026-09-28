import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

export const REDIS_IO_PUB = 'REDIS_IO_PUB';
export const REDIS_IO_SUB = 'REDIS_IO_SUB';

function createRedisClient(configService: ConfigService): Redis {
  return new Redis({
    host: configService.get<string>('REDIS_HOST'),
    port: configService.get<number>('REDIS_PORT'),
    password: configService.get<string>('REDIS_PASSWORD') || undefined,
    db: configService.get<number>('REDIS_DB'),
    lazyConnect: true,
  });
}

export const redisIoPubProvider: Provider = {
  provide: REDIS_IO_PUB,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const client = createRedisClient(configService);
    client.on('error', (err) => {
      console.error('[Redis IO Pub] Connection error:', err.message);
    });
    return client;
  },
};

export const redisIoSubProvider: Provider = {
  provide: REDIS_IO_SUB,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const client = createRedisClient(configService);
    client.on('error', (err) => {
      console.error('[Redis IO Sub] Connection error:', err.message);
    });
    return client;
  },
};