import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly client: Redis;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.client = new Redis({
      host: configService.get<string>('REDIS_HOST'),
      port: configService.get<number>('REDIS_PORT'),
      password: configService.get<string>('REDIS_PASSWORD') || undefined,
      db: configService.get<number>('REDIS_DB'),
      lazyConnect: true,
    });
  }

  async increment(
    key: string,
    ttl: number,
    _limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const trackerKey = `${key}:${throttlerName}:tracker`;
    const blockKey = `${key}:${throttlerName}:block`;

    const blocked = await this.client.exists(blockKey);
    if (blocked) {
      const timeToBlockExpire = await this.client.ttl(blockKey);
      const timeToExpire = await this.client.ttl(trackerKey);
      return {
        totalHits: _limit,
        timeToExpire: timeToExpire > 0 ? timeToExpire : 0,
        isBlocked: true,
        timeToBlockExpire: timeToBlockExpire > 0 ? timeToBlockExpire : 0,
      };
    }

    const totalHits = await this.client.incr(trackerKey);
    if (totalHits === 1) {
      await this.client.expire(trackerKey, ttl);
    }

    const timeToExpire = await this.client.ttl(trackerKey);

    let isBlocked = false;
    let timeToBlockExpire = 0;

    if (totalHits > _limit) {
      isBlocked = true;
      const alreadyBlocked = await this.client.exists(blockKey);
      if (!alreadyBlocked) {
        await this.client.setex(blockKey, blockDuration, '1');
      }
      timeToBlockExpire = await this.client.ttl(blockKey);
    }

    return {
      totalHits,
      timeToExpire: timeToExpire > 0 ? timeToExpire : 0,
      isBlocked,
      timeToBlockExpire,
    };
  }
}
