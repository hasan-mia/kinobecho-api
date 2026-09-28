import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CouponsService } from './coupons.service';
import {
  CreateCouponDto,
  ListCouponsQueryDto,
  ValidateCouponDto,
} from './dto/coupon.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';

@ApiTags('coupons')
@Controller('coupons')
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post()
  @Roles(UserRole.VENDOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('coupon:manage')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a coupon (vendor for own vendorId, admin for platform-wide)',
  })
  @ApiResponse({ status: 201, description: 'Coupon created' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createCouponDto: CreateCouponDto,
  ) {
    return this.couponsService.create(user, createCouponDto);
  }

  @Post('validate')
  @Public()
  @ApiOperation({ summary: 'Validate a coupon against a cart subtotal' })
  async validate(@Body() validateCouponDto: ValidateCouponDto) {
    const result = await this.couponsService.validate(validateCouponDto);

    return {
      code: result.coupon.code,
      discountType: result.coupon.discountType,
      discountValue: result.coupon.discountValue,
      eligibleSubtotal: result.eligibleSubtotal,
      discountAmount: result.discountAmount,
    };
  }

  @Get()
  @Roles(UserRole.VENDOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List coupons' })
  findAll(@Query() query: ListCouponsQueryDto) {
    return this.couponsService.findAll(query);
  }
}
