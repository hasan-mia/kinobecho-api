import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PayoutsService } from './payouts.service';
import {
  ListPayoutsQueryDto,
  RejectPayoutDto,
  RequestPayoutDto,
} from './dto/payout.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';

@ApiTags('payouts')
@ApiBearerAuth()
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

  @Post('request')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @ApiOperation({ summary: 'Request a payout for delivered orders' })
  @ApiResponse({ status: 201, description: 'Payout requested' })
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() requestPayoutDto: RequestPayoutDto,
  ) {
    return this.payoutsService.requestPayout(user, requestPayoutDto.orderIds);
  }

  @Get('vendor')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @ApiOperation({ summary: "List the current vendor's payouts" })
  findVendorPayouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPayoutsQueryDto,
  ) {
    return this.payoutsService.findVendorPayouts(user, query);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('payout:approve')
  @ApiOperation({ summary: 'List all payout transactions' })
  findAll(@Query() query: ListPayoutsQueryDto) {
    return this.payoutsService.findAllPayouts(query);
  }

  @Patch(':transactionId/approve')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('payout:approve')
  @ApiOperation({ summary: 'Approve a payout' })
  approve(@Param('transactionId') transactionId: string) {
    return this.payoutsService.approve(transactionId);
  }

  @Patch(':transactionId/reject')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('payout:approve')
  @ApiOperation({ summary: 'Reject a payout (note required)' })
  reject(
    @Param('transactionId') transactionId: string,
    @Body() rejectPayoutDto: RejectPayoutDto,
  ) {
    return this.payoutsService.reject(transactionId, rejectPayoutDto.note);
  }
}
