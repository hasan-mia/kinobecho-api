import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CACHE_MANAGER, Cache } from './cache.types';

@Injectable()
export class RedisCacheService implements Cache, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis({
      host: configService.get<string>('REDIS_HOST'),
      port: configService.get<number>('REDIS_PORT'),
      password: configService.get<string>('REDIS_PASSWORD') || undefined,
      db: configService.get<number>('REDIS_DB'),
      lazyConnect: true,
    });
  }

  async onModuleInit() {
    try {
      await this.client.ping();
    } catch (err) {
      this.logger.warn(`Redis cache connection failed: ${(err as Error).message}`);
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(key);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
    const payload =
      typeof value === 'string' ? value : JSON.stringify(value);
    if (ttl && ttl > 0) {
      await this.client.set(key, payload, 'EX', ttl);
    } else {
      await this.client.set(key, payload);
    }
  }

  async del(key: string | string[]): Promise<void> {
    if (Array.isArray(key)) {
      if (key.length > 0) {
        await this.client.del(...key);
      }
    } else {
      await this.client.del(key);
    }
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}

export { CACHE_MANAGER, Cache };
