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
import { ReviewsService } from './reviews.service';
import {
  CreateReviewDto,
  ListReviewsQueryDto,
  ModerateReviewDto,
} from './dto/review.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';

@ApiTags('reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post('products/:productId/reviews')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Review a product (requires a delivered order containing the product)',
  })
  @ApiResponse({ status: 201, description: 'Review submitted for moderation' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() createReviewDto: CreateReviewDto,
  ) {
    return this.reviewsService.create(user, productId, createReviewDto);
  }

  @Get('products/:productId/reviews')
  @Public()
  @ApiOperation({ summary: 'List approved reviews for a product' })
  findByProduct(
    @Param('productId') productId: string,
    @Query() query: ListReviewsQueryDto,
  ) {
    return this.reviewsService.findByProduct(productId, query);
  }

  @Get('products/:productId/reviews/rating-summary')
  @Public()
  @ApiOperation({ summary: 'Get the average rating for a product' })
  ratingSummary(@Param('productId') productId: string) {
    return this.reviewsService.getRatingSummary(productId);
  }

  @Patch(':id/moderate')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('review:moderate')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve or reject a review' })
  moderate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() moderateReviewDto: ModerateReviewDto,
  ) {
    return this.reviewsService.moderate(id, user, moderateReviewDto);
  }
}
