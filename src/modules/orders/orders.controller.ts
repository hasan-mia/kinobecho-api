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
import { OrdersService } from './orders.service';
import {
  CheckoutDto,
  ListOrdersQueryDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Checkout the cart, splitting it per vendor' })
  @ApiResponse({ status: 201, description: 'Orders created' })
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() checkoutDto: CheckoutDto,
  ) {
    return this.ordersService.checkout(user, checkoutDto);
  }

  @Get('vendor')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @ApiOperation({ summary: "List the current vendor's orders" })
  vendorOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.ordersService.findVendorOrders(user, query);
  }

  @Get()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "List the current buyer's orders" })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.ordersService.findMyOrders(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an order (buyer, owning vendor or admin)' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ordersService.findOne(user, id);
  }

  @Patch(':id/status')
  @Roles(
    UserRole.VENDOR,
    UserRole.VENDOR_STAFF,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @ApiOperation({ summary: 'Update an order status' })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() updateOrderStatusDto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateStatus(user, id, updateOrderStatusDto);
  }
}
