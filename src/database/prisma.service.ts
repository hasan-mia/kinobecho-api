import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(configService: ConfigService) {
    const provider = configService.get<string>('DATABASE_PROVIDER') ?? 'postgresql';
    const url = configService.get<string>('DATABASE_URL');

    super({
      datasources: {
        db: {
          url,
        },
      },
      log: ['error', 'warn'],
      errorFormat: 'colorless',
    });

    this.logger.log(`Database provider: ${provider}`);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}