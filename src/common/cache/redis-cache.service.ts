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

  /**
   * INCR then, only on the call that created the key (result === 1), set the TTL.
   *
   * Redis has no combined INCR+EXPIRE, and doing it in two round trips would let
   * a crash in between leave a counter that never expires. The `result === 1`
   * check keeps the window anchored to the first hit rather than being extended
   * by later ones, so a caller cannot keep a slot alive by polling.
   */
  async incrWithTtl(key: string, ttl?: number): Promise<number> {
    const result = await this.client.incr(key);

    if (result === 1 && ttl && ttl > 0) {
      await this.client.expire(key, ttl);
    }

    return result;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}

export { CACHE_MANAGER, Cache };
