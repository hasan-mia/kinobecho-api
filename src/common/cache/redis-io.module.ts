import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { REDIS_IO_PUB, REDIS_IO_SUB, redisIoPubProvider, redisIoSubProvider } from './redis-io.provider';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [redisIoPubProvider, redisIoSubProvider],
  exports: [REDIS_IO_PUB, REDIS_IO_SUB],
})
export class RedisIoModule {}