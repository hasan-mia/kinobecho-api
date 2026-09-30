import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, ReviewStatus, UserRole } from '@prisma/client';
import { ReviewsService } from '../src/modules/reviews/reviews.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const admin = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.SUPER_ADMIN,
  roleId: null,
  vendor: null,
} as unknown as AuthenticatedUser;

const moderationDto = (status: ReviewStatus) =>
  ({ status, reason: status === ReviewStatus.REJECTED ? 'rude' : undefined }) as never;

describe('product rating recalculation on moderation', () => {
  let prisma: any;
  let service: ReviewsService;
  let search: { enqueueUpsert: ReturnType<typeof vi.fn> };

  const approvedRatings = (ratings: number[]) => {
    prisma.review.aggregate.mockResolvedValue({
      _avg: { rating: ratings.reduce((a, b) => a + b, 0) / ratings.length },
      _count: { rating: ratings.length },
    });
  };

  beforeEach(() => {
    prisma = {
      review: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'r1',
          productId: 'p1',
          status: ReviewStatus.PENDING,
          rating: 5,
        }),
        update: vi.fn().mockResolvedValue({ id: 'r1' }),
        aggregate: vi.fn(),
      },
      product: { update: vi.fn().mockResolvedValue({}) },
    };

    search = { enqueueUpsert: vi.fn().mockResolvedValue(undefined) };

    service = new ReviewsService(
      prisma as unknown as PrismaService,
      search as never,
    );
  });

  it('writes the average and the count onto the product', async () => {
    approvedRatings([4, 5]);

    await service.moderate('r1', admin, moderationDto(ReviewStatus.APPROVED));

    const data = prisma.product.update.mock.calls[0][0].data;

    expect(data.ratingAvg.toFixed(2)).toBe('4.50');
    expect(data.ratingCount).toBe(2);
  });

  it('recomputes rather than applying a delta', async () => {
    approvedRatings([3]);

    await service.moderate('r1', admin, moderationDto(ReviewStatus.REJECTED));

    // A delta would need the review's previous contribution; a full aggregate
    // cannot be wrong no matter how often the review is flipped.
    expect(prisma.review.aggregate).toHaveBeenCalledWith({
      where: { productId: 'p1', status: ReviewStatus.APPROVED },
      _avg: { rating: true },
      _count: { rating: true },
    });
  });

  it('excludes pending and rejected reviews from the aggregate', async () => {
    approvedRatings([5]);
    await service.moderate('r1', admin, moderationDto(ReviewStatus.APPROVED));

    const where = prisma.review.aggregate.mock.calls[0][0].where;
    expect(where.status).toBe(ReviewStatus.APPROVED);
  });

  it('rounds half-up, so a product never shows 4.005', async () => {
    // Three 5s and one 4 average 4.75 exactly; use a .005 tie instead.
    prisma.review.aggregate.mockResolvedValue({
      _avg: { rating: 4.125 },
      _count: { rating: 8 },
    });

    await service.moderate('r1', admin, moderationDto(ReviewStatus.APPROVED));

    expect(prisma.product.update.mock.calls[0][0].data.ratingAvg.toFixed(2)).toBe(
      '4.13',
    );
  });

  it('writes zero rather than null when the last review is rejected', async () => {
    prisma.review.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { rating: 0 },
    });

    await service.moderate('r1', admin, moderationDto(ReviewStatus.REJECTED));

    const data = prisma.product.update.mock.calls[0][0].data;

    expect(data.ratingAvg.toFixed(2)).toBe('0.00');
    expect(data.ratingCount).toBe(0);
  });

  it('re-indexes the product so search reflects the new average', async () => {
    approvedRatings([5]);

    await service.moderate('r1', admin, moderationDto(ReviewStatus.APPROVED));

    expect(search.enqueueUpsert).toHaveBeenCalledWith('p1');
  });

  it('does not recalculate when a moderation is refused', async () => {
    await expect(
      service.moderate('r1', admin, moderationDto(ReviewStatus.PENDING)),
    ).rejects.toThrow();

    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('does not recalculate for a review that does not exist', async () => {
    prisma.review.findUnique.mockResolvedValue(null);

    await expect(
      service.moderate('missing', admin, moderationDto(ReviewStatus.APPROVED)),
    ).rejects.toThrow(/not found/i);

    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('keeps the aggregate on the product consistent with the summary endpoint', async () => {
    approvedRatings([5, 4, 3]);

    await service.moderate('r1', admin, moderationDto(ReviewStatus.APPROVED));

    const written = prisma.product.update.mock.calls[0][0].data;

    const summary = await service.getRatingSummary('p1');

    expect(new Prisma.Decimal(summary.averageRating).toFixed(2)).toBe(
      written.ratingAvg.toFixed(2),
    );
    expect(summary.totalReviews).toBe(written.ratingCount);
  });
});
