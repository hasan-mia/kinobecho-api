import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageDriver } from '@prisma/client';
import { PrismaModule } from '../../database/prisma.module';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { LocalStorageProvider } from './providers/local.provider';
import { S3StorageProvider } from './providers/s3.provider';
import { GcsStorageProvider } from './providers/gcs.provider';
import { STORAGE_DRIVER_NAME, STORAGE_PROVIDER } from './storage.constants';
import { StorageProvider } from './interfaces/storage-provider.interface';

function resolveDriver(configService: ConfigService): string {
  return (
    configService.get<string>('storage.driver') ??
    configService.get<string>('STORAGE_DRIVER') ??
    'local'
  ).toLowerCase();
}

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [StorageController],
  providers: [
    {
      provide: STORAGE_DRIVER_NAME,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): StorageDriver => {
        switch (resolveDriver(configService)) {
          case 's3':
            return StorageDriver.S3;
          case 'gcs':
            return StorageDriver.GCS;
          default:
            return StorageDriver.LOCAL;
        }
      },
    },
    {
      provide: STORAGE_PROVIDER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): StorageProvider => {
        switch (resolveDriver(configService)) {
          case 's3':
            return new S3StorageProvider(configService);
          case 'gcs':
            return new GcsStorageProvider(configService);
          default:
            return new LocalStorageProvider(configService);
        }
      },
    },
    StorageService,
  ],
  exports: [StorageService, STORAGE_PROVIDER],
})
export class StorageModule {}
