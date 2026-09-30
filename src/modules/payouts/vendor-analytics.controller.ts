import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { VendorAnalyticsService } from './vendor-analytics.service';
import {
  AdminOverviewQueryDto,
  VendorAnalyticsQueryDto,
} from './dto/analytics.dto';

/**
 * Vendor self-service routes. Every handler is scoped by the vendor id on the
 * authenticated principal, never by a path parameter, so a vendor can only ever
 * see their own figures.
 */
@ApiTags('vendor-wallet')
@ApiBearerAuth()
@Controller('vendors/me')
@Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
export class VendorAnalyticsController {
  constructor(private readonly analytics: VendorAnalyticsService) {}

  @Get('wallet')
  @ApiOperation({ summary: "Wallet balances for the current vendor" })
  @ApiResponse({ status: 200, description: 'Balances as decimal strings' })
  wallet(@CurrentUser() user: AuthenticatedUser) {
    return this.analytics.wallet(user);
  }

  @Get('analytics')
  @ApiOperation({ summary: 'Sales analytics for the current vendor' })
  @ApiResponse({ status: 200, description: 'Totals, timeseries and top products' })
  vendorAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: VendorAnalyticsQueryDto,
  ) {
    return this.analytics.analytics(user, query);
  }

  @Get('inventory/low-stock')
  @ApiOperation({ summary: 'Variants at or below their low-stock threshold' })
  @ApiResponse({ status: 200, description: 'Low stock variants' })
  lowStockVariants(@CurrentUser() user: AuthenticatedUser) {
    return this.analytics.lowStock(user);
  }
}

/**
 * Platform-wide reporting. Guarded by the `analytics:read` permission rather
 * than the ADMIN role alone, so it can be delegated to a finance operator.
 */
@ApiTags('admin-analytics')
@ApiBearerAuth()
@Controller('admin/analytics')
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@RequirePermissions('analytics:read')
export class AdminAnalyticsController {
  constructor(private readonly analytics: VendorAnalyticsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Platform GMV, commission and top vendors' })
  @ApiResponse({ status: 200, description: 'Aggregated platform figures' })
  overview(@Query() query: AdminOverviewQueryDto) {
    return this.analytics.platformOverview(query);
  }
}
