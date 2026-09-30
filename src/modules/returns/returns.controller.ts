import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { ReturnsService } from './returns.service';
import {
  CreateReturnDto,
  ListReturnsQueryDto,
  ReceiveReturnDto,
  RefundReturnDto,
  ReturnDecisionDto,
} from './dto/returns.dto';

@ApiTags('returns')
@ApiBearerAuth()
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Post()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary: 'File a return against a delivered order',
    description:
      'Order must be DELIVERED and inside RETURN_WINDOW_DAYS of the delivery ' +
      'event. Per-line quantities may not exceed what was bought minus what is ' +
      'already covered by another live return.',
  })
  @ApiResponse({ status: 201, description: 'Return request created as REQUESTED' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReturnDto,
  ) {
    return this.returns.create(user, dto);
  }

  /**
   * The buyer's own returns. Scoped by the token, so there is no vendorId or
   * buyerId parameter that could widen it.
   */
  @Get()
  @ApiOperation({ summary: 'Return requests filed by the current buyer' })
  listOwn(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListReturnsQueryDto,
  ) {
    return this.returns.listForBuyer(user, query);
  }

  @Get('vendor')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @ApiOperation({ summary: 'Return requests against the current vendor\'s orders' })
  listVendor(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListReturnsQueryDto,
  ) {
    return this.returns.listForVendor(user, query);
  }

  @Get('admin')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('return:read')
  @ApiOperation({ summary: 'Every return request, filterable' })
  listAdmin(@Query() query: ListReturnsQueryDto) {
    return this.returns.listForAdmin(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One return request (buyer, owning vendor, or admin)' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.returns.findOne(user, id);
  }

  @Patch(':id/decision')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Approve or reject a return request' })
  @ApiResponse({ status: 400, description: 'Reject requires a note' })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnDecisionDto,
  ) {
    return this.returns.decide(user, id, dto);
  }

  @Patch(':id/received')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Mark returned goods as received, optionally restocking' })
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveReturnDto,
  ) {
    return this.returns.receive(user, id, dto);
  }

  @Post(':id/refund')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('return:refund')
  @ApiOperation({
    summary: 'Refund a received return',
    description:
      'Amount is the returned lines less the proportional share of the order ' +
      'discount, plus shipping when includeShipping is set. Online payments ' +
      'call the gateway; COD refunds stay PENDING until confirmed via ' +
      'PATCH /payments/refunds/:transactionId/confirm.',
  })
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundReturnDto,
  ) {
    return this.returns.refund(user, id, dto);
  }
}
