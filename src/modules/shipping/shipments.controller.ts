import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ShippingService } from './shipping.service';
import {
  CreateManualShipmentDto,
  CreateShipmentDto,
  UpdateShipmentStatusDto,
} from './dto/shipping.dto';

@ApiTags('shipments')
@ApiBearerAuth()
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shippingService: ShippingService) {}

  @Post()
  @RequirePermissions('shipment:create')
  @ApiOperation({ summary: 'Create a shipment with a courier' })
  @ApiResponse({ status: 201, description: 'Shipment created' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateShipmentDto,
  ) {
    return this.shippingService.createShipment(user, dto);
  }

  @Post('manual')
  @RequirePermissions('shipment:create')
  @ApiOperation({ summary: 'Create a shipment with a vendor-supplied tracking code' })
  createManual(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateManualShipmentDto,
  ) {
    return this.shippingService.createManualShipment(user, dto);
  }

  @Get('order/:orderId')
  @ApiOperation({ summary: 'Get the shipment of an order (buyer, vendor or admin)' })
  findByOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
  ) {
    return this.shippingService.findByOrder(user, orderId);
  }

  @Post(':id/cancel')
  @RequirePermissions('shipment:create')
  @ApiOperation({ summary: 'Cancel a pending shipment' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.shippingService.cancelShipment(user, id);
  }

  @Patch(':id/status')
  @RequirePermissions('shipment:create')
  @ApiOperation({ summary: 'Update a shipment status (manual courier)' })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateShipmentStatusDto,
  ) {
    return this.shippingService.updateStatus(user, id, dto);
  }
}
