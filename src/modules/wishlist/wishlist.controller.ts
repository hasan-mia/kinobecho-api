import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { WishlistService } from './wishlist.service';
import { ListWishlistQueryDto } from './dto/wishlist.dto';

@ApiTags('wishlist')
@ApiBearerAuth()
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  @Post(':productId')
  @ApiOperation({
    summary: 'Save a product',
    description: 'Idempotent: saving twice returns the same item.',
  })
  add(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.wishlist.add(user, productId);
  }

  @Delete(':productId')
  @ApiOperation({ summary: 'Remove a saved product (no-op if not saved)' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.wishlist.remove(user, productId);
  }

  @Get()
  @ApiOperation({ summary: "The current buyer's wishlist, with live price and stock" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListWishlistQueryDto,
  ) {
    return this.wishlist.list(user, query);
  }
}
