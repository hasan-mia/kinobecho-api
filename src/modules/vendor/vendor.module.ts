import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VendorController } from './vendor.controller';
import { VendorService } from './vendor.service';
import { VendorKycService } from './vendor-kyc.service';
import { PrismaModule } from '../../database/prisma.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [ConfigModule, PrismaModule, StorageModule],
  controllers: [VendorController],
  providers: [VendorService, VendorKycService],
  exports: [VendorService],
})
export class VendorModule {}
