import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../../database/prisma.module';
import { RedisIoModule } from '../../common/cache/redis-io.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatGateway } from './gateways/chat.gateway';
import { WsJwtGuard } from './guards/ws-jwt.guard';

@Module({
  imports: [ConfigModule, JwtModule.register({}), PrismaModule, RedisIoModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, WsJwtGuard],
  exports: [ChatService],
})
export class ChatModule {}