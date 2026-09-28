import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { Inject, Logger, UseGuards } from '@nestjs/common';
import { REDIS_IO_PUB, REDIS_IO_SUB } from '../../../common/cache/redis-io.provider';
import { WsJwtGuard } from '../guards/ws-jwt.guard';
import { ChatService } from '../chat.service';
import { SendMessageDto, TypingDto, ReadMessageDto, JoinThreadDto } from '../dto/chat.dto';
import { AuthenticatedUser } from '../../../common/guards/roles.guard';

const RATE_LIMIT_MAX_MESSAGES = 20;
const RATE_LIMIT_WINDOW_SECONDS = 10;

interface AuthenticatedSocket extends Socket {
  data: {
    user: AuthenticatedUser;
  };
}

@WebSocketGateway({ cors: true })
@UseGuards(WsJwtGuard)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);
  constructor(
    private readonly chatService: ChatService,
    @Inject(REDIS_IO_PUB) private readonly pubClient: Redis,
    @Inject(REDIS_IO_SUB) private readonly subClient: Redis,
  ) {}

  async afterInit(server: Server) {
    server.adapter(createAdapter(this.pubClient, this.subClient));
    this.logger.log('Socket.io Redis adapter initialized');
  }

  async handleConnection(client: AuthenticatedSocket) {
    this.logger.log(`Client connected: ${client.id}, user: ${client.data.user?.id}`);
  }

  async handleDisconnect(client: AuthenticatedSocket) {
    this.logger.log(`Client disconnected: ${client.id}, user: ${client.data.user?.id}`);
  }

  @SubscribeMessage('chat:join')
  async handleJoin(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: JoinThreadDto,
  ) {
    const { threadId } = dto;
    const user = client.data.user;

    const isParticipant = await this.chatService.validateThreadParticipant(threadId, user);
    if (!isParticipant) {
      return { success: false, error: 'Not a participant of this thread' };
    }

    await client.join(threadId);
    this.logger.log(`User ${user.id} joined thread ${threadId}`);

    return { success: true };
  }

  @SubscribeMessage('chat:message:send')
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: SendMessageDto,
  ) {
    if (!(await this.consumeRateLimit(client.id))) {
      return { success: false, error: 'Rate limit exceeded: 20 messages per 10 seconds' };
    }

    const { threadId, content, attachmentUrl } = dto;
    const user = client.data.user;

    const isParticipant = await this.chatService.validateThreadParticipant(threadId, user);
    if (!isParticipant) {
      return { success: false, error: 'Not a participant of this thread' };
    }

    const message = await this.chatService.sendMessage(
      threadId,
      user.id,
      content ?? '',
      attachmentUrl,
    );

    this.server.to(threadId).emit('chat:message:receive', message);

    return { success: true, message };
  }

  @SubscribeMessage('chat:typing')
  async handleTyping(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: TypingDto,
  ) {
    const { threadId } = dto;
    const user = client.data.user;

    const isParticipant = await this.chatService.validateThreadParticipant(threadId, user);
    if (!isParticipant) {
      return { success: false, error: 'Not a participant of this thread' };
    }

    client.to(threadId).emit('chat:typing', { userId: user.id, userName: user.name });

    return { success: true };
  }

  @SubscribeMessage('chat:read')
  async handleRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: ReadMessageDto,
  ) {
    const { threadId, messageId } = dto;
    const user = client.data.user;

    const isParticipant = await this.chatService.validateThreadParticipant(threadId, user);
    if (!isParticipant) {
      return { success: false, error: 'Not a participant of this thread' };
    }

    await this.chatService.markAsRead(threadId, user.id, messageId);

    this.server.to(threadId).emit('chat:read', { userId: user.id, messageId });

    return { success: true };
  }

  private async consumeRateLimit(socketId: string): Promise<boolean> {
    const key = `ratelimit:chat:message:send:${socketId}`;

    try {
      const count = await this.pubClient.incr(key);

      if (count === 1) {
        await this.pubClient.expire(key, RATE_LIMIT_WINDOW_SECONDS);
      }

      return count <= RATE_LIMIT_MAX_MESSAGES;
    } catch (error) {
      this.logger.warn(
        `Rate limit check failed, allowing message: ${(error as Error).message}`,
      );
      return true;
    }
  }
}