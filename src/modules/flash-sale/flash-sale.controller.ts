import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FlashSaleItemStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { FlashSaleService } from './flash-sale.service';
import {
  CreateFlashSaleDto,
  FlashSaleIdParamDto,
  FlashSaleItemIdParamDto,
  ListFlashSalesQueryDto,
  ModerateItemDto,
  NominateItemDto,
  UpdateFlashSaleDto,
  UpdateFlashSaleItemDto,
} from './dto/flash-sale.dto';

@ApiTags('flash-sales')
@Controller('flash-sales')
export class FlashSaleController {
  constructor(private readonly flashSales: FlashSaleService) {}

  @Get('active')
  @Public()
  @ApiOperation({ summary: 'Flash sales live right now, with remaining budget' })
  listActive() {
    return this.flashSales.listActive();
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('flashsale:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List flash sales' })
  list(@Query() query: ListFlashSalesQueryDto) {
    return this.flashSales.list(query);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('flashsale:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a flash sale with its items' })
  findOne(@Param() params: FlashSaleIdParamDto) {
    return this.flashSales.findOne(params.id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('flashsale:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a flash sale' })
  create(@Body() dto: CreateFlashSaleDto) {
    return this.flashSales.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('flashsale:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a flash sale' })
  update(@Param() params: FlashSaleIdParamDto, @Body() dto: UpdateFlashSaleDto) {
    return this.flashSales.update(params.id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('flashsale:manage')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a flash sale and its items' })
  remove(@Param() params: FlashSaleIdParamDto) {
    return this.flashSales.remove(params.id);
  }

  @Post(':id/nominate')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Nominate one of your products for a flash sale' })
  nominate(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: FlashSaleIdParamDto,
    @Body() dto: NominateItemDto,
  ) {
    return this.flashSales.nominate(user, params.id, dto);
  }

  @Patch(':id/items/:itemId')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('flashsale:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edit a nomination price or budget' })
  updateItem(
    @Param() params: FlashSaleIdParamDto & FlashSaleItemIdParamDto,
    @Body() dto: UpdateFlashSaleItemDto,
  ) {
    return this.flashSales.updateItem(params.itemId, dto);
  }

  @Patch(':id/items/:itemId/moderate')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('flashsale:manage')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Approve or reject a nomination',
    description: `Only ${FlashSaleItemStatus.APPROVED} makes the sale price reachable at checkout.`,
  })
  moderateItem(
    @Param() params: FlashSaleIdParamDto & FlashSaleItemIdParamDto,
    @Body() dto: ModerateItemDto,
  ) {
    return this.flashSales.moderateItem(params.itemId, dto);
  }

  @Delete(':id/items/:itemId')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('flashsale:manage')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a nomination' })
  removeItem(@Param() params: FlashSaleIdParamDto & FlashSaleItemIdParamDto) {
    return this.flashSales.removeItem(params.itemId);
  }
}
