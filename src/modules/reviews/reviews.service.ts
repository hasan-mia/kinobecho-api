import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { SearchSyncService } from '../search/search-sync.service';
import {
  CreateReviewDto,
  ListReviewsQueryDto,
  ModerateReviewDto,
} from './dto/review.dto';

/** Ratings are 1-5, so two decimals is the most the column can ever hold. */
const RATING_PRECISION = 2;

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchSyncService,
  ) {}

  async create(user: AuthenticatedUser, productId: string, dto: CreateReviewDto) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const existing = await this.prisma.review.findUnique({
      where: { productId_userId: { productId, userId: user.id } },
    });

    if (existing) {
      throw new ConflictException('You have already reviewed this product');
    }

    const isVerifiedPurchase = await this.hasDeliveredOrder(user.id, productId);

    if (!isVerifiedPurchase) {
      throw new ForbiddenException(
        'Only customers with a delivered order for this product can review it',
      );
    }

    return this.prisma.review.create({
      data: {
        productId,
        userId: user.id,
        rating: dto.rating,
        comment: dto.comment,
        isVerifiedPurchase: true,
        status: ReviewStatus.PENDING,
      },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async findByProduct(
    productId: string,
    query: ListReviewsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ReviewWhereInput = {
      productId,
      status: ReviewStatus.APPROVED,
    };

    const [items, total, aggregate] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.aggregate({
        where,
        _avg: { rating: true },
        _count: { rating: true },
      }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        averageRating: aggregate._avg.rating ?? 0,
        totalReviews: aggregate._count.rating,
      },
    };
  }

  async getRatingSummary(productId: string) {
    const aggregate = await this.prisma.review.aggregate({
      where: { productId, status: ReviewStatus.APPROVED },
      _avg: { rating: true },
      _count: { rating: true },
    });

    return {
      productId,
      averageRating: aggregate._avg.rating ?? 0,
      totalReviews: aggregate._count.rating,
    };
  }

  async moderate(id: string, user: AuthenticatedUser, dto: ModerateReviewDto) {
    if (dto.status === ReviewStatus.PENDING) {
      throw new ForbiddenException('A review can only be approved or rejected');
    }

    const review = await this.prisma.review.findUnique({ where: { id } });

    if (!review) {
      throw new NotFoundException('Review not found');
    }

    const updated = await this.prisma.review.update({
      where: { id: review.id },
      data: { status: dto.status, moderatedById: user.id },
      include: {
        user: { select: { id: true, name: true } },
        product: { select: { id: true, name: true } },
      },
    });

    // Approving a review raises the product's average; rejecting one lowers it
    // again. The aggregate is denormalised onto the product so the listing and
    // search endpoints can sort by rating without joining every review.
    await this.recalculateProductRating(review.productId);
    await this.search.enqueueUpsert(review.productId);

    return updated;
  }

  /**
   * Recomputes a product's rating aggregate from its APPROVED reviews.
   *
   * Recomputed rather than incremented. A delta would drift: every moderation
   * path would have to know the review's *previous* contribution, and a
   * review flipped twice would apply the wrong one. A full recompute is one
   * cheap aggregate over an already-indexed `(productId, status)` and cannot be
   * wrong.
   *
   * Rounded half-up, matching the commission and refund rounding, so a product
   * cannot show 4.005 and lose the half.
   */
  async recalculateProductRating(productId: string): Promise<void> {
    const aggregate = await this.prisma.review.aggregate({
      where: { productId, status: ReviewStatus.APPROVED },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const count = aggregate._count.rating;

    await this.prisma.product.update({
      where: { id: productId },
      data: {
        ratingAvg: new Prisma.Decimal(aggregate._avg.rating ?? 0)
          .toDecimalPlaces(RATING_PRECISION, Prisma.Decimal.ROUND_HALF_UP),
        ratingCount: count,
      },
    });
  }

  private async hasDeliveredOrder(
    userId: string,
    productId: string,
  ): Promise<boolean> {
    const order = await this.prisma.order.findFirst({
      where: {
        buyerId: userId,
        status: OrderStatus.DELIVERED,
        items: {
          some: { productVariant: { productId } },
        },
      },
      select: { id: true },
    });

    return order !== null;
  }
}
