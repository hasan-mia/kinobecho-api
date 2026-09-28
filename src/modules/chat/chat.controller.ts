import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  Patch,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { ChatService } from './chat.service';
import { CreateThreadDto } from './dto/chat.dto';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('threads')
  @Roles(UserRole.CUSTOMER, UserRole.VENDOR, UserRole.VENDOR_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create or find a chat thread' })
  @ApiResponse({ status: 201, description: 'Thread created or retrieved' })
  async createThread(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateThreadDto,
  ) {
    return this.chatService.createOrFindThread(user, dto.vendorId);
  }

  @Get('threads')
  @Roles(UserRole.CUSTOMER, UserRole.VENDOR, UserRole.VENDOR_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get current user\'s chat threads' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of threads' })
  async getThreads(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.chatService.getUserThreads(user, Number(page), Number(limit));
  }

  @Get('threads/:id/messages')
  @Roles(UserRole.CUSTOMER, UserRole.VENDOR, UserRole.VENDOR_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get paginated message history for a thread' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of messages' })
  async getThreadMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') threadId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
  ) {
    return this.chatService.getThreadMessages(threadId, user, Number(page), Number(limit));
  }

  @Patch('threads/:id/assign')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('promotion:manage')
  @ApiOperation({ summary: 'Assign an admin to a BUYER_SUPPORT thread (admin only)' })
  @ApiResponse({ status: 200, description: 'Thread assigned to admin' })
  async assignThread(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') threadId: string,
    @Body() body: { adminId: string },
  ) {
    return this.chatService.assignAdminToThread(threadId, body.adminId, user);
  }
}