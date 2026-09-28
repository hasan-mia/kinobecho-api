import {
  Controller,
  Post,
  Delete,
  Param,
  Body,
  Get,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { NotificationService } from './notification.service';
import {
  RegisterDeviceTokenDto,
  SendTransactionalEmailDto,
} from './dto/notification.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post('device-tokens')
  @Roles(UserRole.CUSTOMER, UserRole.VENDOR, UserRole.VENDOR_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Register or update a device token for push notifications' })
  @ApiResponse({ status: 201, description: 'Device token registered' })
  async registerDeviceToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    return this.notificationService.registerDeviceToken(user.id, dto.token, dto.platform);
  }

  @Delete('device-tokens/:token')
  @Roles(UserRole.CUSTOMER, UserRole.VENDOR, UserRole.VENDOR_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Remove a device token' })
  @ApiResponse({ status: 200, description: 'Device token removed' })
  async removeDeviceToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ) {
    return this.notificationService.removeDeviceToken(user.id, token);
  }
}