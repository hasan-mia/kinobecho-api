import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RfqService } from './rfq.service';
import { RfqController } from './rfq.controller';
import { PrismaModule } from '../../database/prisma.module';
import { OrdersModule } from '../orders/orders.module';
import { ChatModule } from '../chat/chat.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [PrismaModule, ConfigModule, OrdersModule, ChatModule, NotificationModule],
  controllers: [RfqController],
  providers: [RfqService],
  exports: [RfqService],
})
export class RfqModule {}
