import { Module } from '@nestjs/common';
import { FlashSaleController } from './flash-sale.controller';
import { FlashSaleService } from './flash-sale.service';
import { PrismaModule } from '../../database/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [FlashSaleController],
  providers: [FlashSaleService],
  exports: [FlashSaleService],
})
export class FlashSaleModule {}
