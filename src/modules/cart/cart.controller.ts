import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { UserRole } from '@prisma/client';
import { CartService } from './cart.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';

@ApiTags('cart')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current user cart with live prices' })
  getCart(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.getCart(user.id);
  }

  @Post('items')
  @ApiOperation({ summary: 'Add an item to the cart (upserts on repeat)' })
  @ApiResponse({ status: 201, description: 'Item added' })
  addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() addCartItemDto: AddCartItemDto,
  ) {
    return this.cartService.addItem(user.id, addCartItemDto);
  }

  @Patch('items/:id')
  @ApiOperation({ summary: 'Update a cart item quantity' })
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() updateCartItemDto: UpdateCartItemDto,
  ) {
    return this.cartService.updateItem(user.id, id, updateCartItemDto);
  }

  @Delete('items/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a cart item' })
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.cartService.removeItem(user.id, id);
  }

  @Delete()
  @HttpCode(200)
  @ApiOperation({ summary: 'Clear the cart' })
  clear(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.clear(user.id);
  }
}
