import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import {
  CreateReviewDto,
  ListReviewsQueryDto,
  ModerateReviewDto,
} from './dto/review.dto';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

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

    return this.prisma.review.update({
      where: { id: review.id },
      data: { status: dto.status, moderatedById: user.id },
      include: {
        user: { select: { id: true, name: true } },
        product: { select: { id: true, name: true } },
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
