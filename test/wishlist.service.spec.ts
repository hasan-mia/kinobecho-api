import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, ProductStatus, SaleType, UserRole } from '@prisma/client';
import { WishlistService } from '../src/modules/wishlist/wishlist.service';
import { PrismaService } from '../src/database/prisma.service';
import { ProductPricingService } from '../src/modules/product/pricing/product-pricing.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const dec = (v: string) => new Prisma.Decimal(v);

const buyer = {
  id: 'buyer-1',
  email: 'buyer@example.com',
  name: 'Buyer',
  role: UserRole.CUSTOMER,
  roleId: null,
  vendor: null,
} as unknown as AuthenticatedUser;

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'w1',
  userId: 'buyer-1',
  productId: 'p1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  product: {
    id: 'p1',
    name: 'Widget',
    slug: 'widget',
    price: dec('250.00'),
    status: ProductStatus.ACTIVE,
    saleType: SaleType.RETAIL,
    deletedAt: null,
    images: [{ thumbUrl: 'http://cdn/t.webp', url: 'http://cdn/l.webp' }],
    variants: [{ stock: 3 }, { stock: 4 }],
    priceTiers: [],
    vendor: { id: 'v1', businessName: 'V', slug: 'v' },
  },
  ...overrides,
});

const uniqueViolation = Object.assign(new Error('unique'), { code: 'P2002' });

describe('WishlistService.add — idempotency', () => {
  let prisma: any;
  let service: WishlistService;

  beforeEach(() => {
    prisma = {
      product: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'p1', status: ProductStatus.ACTIVE }),
      },
      wishlistItem: {
        create: vi.fn().mockResolvedValue(row()),
        findUniqueOrThrow: vi.fn().mockResolvedValue(row()),
      },
    };

    service = new WishlistService(
      prisma as unknown as PrismaService,
      { resolveUnitPrice: vi.fn().mockResolvedValue(dec('250.00')) } as never,
    );
  });

  it('creates the row on the first add', async () => {
    await service.add(buyer, 'p1');

    expect(prisma.wishlistItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { userId: 'buyer-1', productId: 'p1' },
      }),
    );
  });

  it('returns the existing row when the same product is added twice', async () => {
    // The unique constraint is the guard; a pre-check would still race two
    // taps of the same button.
    prisma.wishlistItem.create.mockRejectedValue(uniqueViolation);

    const result = await service.add(buyer, 'p1');

    expect(result.id).toBe('w1');
    expect(prisma.wishlistItem.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_productId: { userId: 'buyer-1', productId: 'p1' } },
      }),
    );
  });

  it('does not report an error on a duplicate', async () => {
    prisma.wishlistItem.create.mockRejectedValue(uniqueViolation);

    await expect(service.add(buyer, 'p1')).resolves.toBeDefined();
  });

  it('rethrows anything that is not a unique violation', async () => {
    prisma.wishlistItem.create.mockRejectedValue(new Error('connection lost'));

    await expect(service.add(buyer, 'p1')).rejects.toThrow('connection lost');
  });

  it('refuses a product that does not exist', async () => {
    prisma.product.findFirst.mockResolvedValue(null);

    await expect(service.add(buyer, 'p1')).rejects.toThrow(/not found/i);
    expect(prisma.wishlistItem.create).not.toHaveBeenCalled();
  });

  it('refuses a product that is not ACTIVE', async () => {
    prisma.product.findFirst.mockResolvedValue({
      id: 'p1',
      status: ProductStatus.ARCHIVED,
    });

    await expect(service.add(buyer, 'p1')).rejects.toThrow(/not available/i);
  });
});

describe('WishlistService.remove', () => {
  let prisma: any;
  let service: WishlistService;

  beforeEach(() => {
    prisma = {
      wishlistItem: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    service = new WishlistService(prisma as unknown as PrismaService, {} as never);
  });

  it('scopes the delete to the current user', async () => {
    await service.remove(buyer, 'p1');

    expect(prisma.wishlistItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'buyer-1', productId: 'p1' },
    });
  });

  it('reports whether anything was actually removed', async () => {
    await expect(service.remove(buyer, 'p1')).resolves.toEqual({ removed: true });
  });

  it('is a no-op, not an error, when the product was not saved', async () => {
    prisma.wishlistItem.deleteMany.mockResolvedValue({ count: 0 });

    // A double tap on "remove" is a user gesture, not a client bug.
    await expect(service.remove(buyer, 'p1')).resolves.toEqual({ removed: false });
  });
});

describe('WishlistService.list', () => {
  let prisma: any;
  let pricing: { resolveUnitPrice: ReturnType<typeof vi.fn> };
  let service: WishlistService;

  beforeEach(() => {
    pricing = { resolveUnitPrice: vi.fn().mockResolvedValue(dec('240.00')) };

    prisma = {
      wishlistItem: {
        findMany: vi.fn().mockResolvedValue([row()]),
        count: vi.fn().mockResolvedValue(1),
      },
    };

    prisma.$transaction = vi.fn((args: unknown) =>
      Array.isArray(args) ? Promise.all(args) : args,
    );

    service = new WishlistService(
      prisma as unknown as PrismaService,
      pricing as never,
    );
  });

  it('returns the pagination envelope', async () => {
    const result = await service.list(buyer, { page: 1, limit: 20 });

    expect(result.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
  });

  it('paginates in the database, not in memory', async () => {
    await service.list(buyer, { page: 3, limit: 10 });

    expect(prisma.wishlistItem.findMany.mock.calls[0][0]).toEqual(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('reports the price as a string, like every other money surface', async () => {
    const result = await service.list(buyer, { page: 1, limit: 20 });

    expect(result.items[0]?.product.price).toBe('240.00');
  });

  it('resolves the price now rather than storing one at save time', async () => {
    await service.list(buyer, { page: 1, limit: 20 });

    expect(pricing.resolveUnitPrice).toHaveBeenCalledWith('p1', 1);
  });

  it('falls back to the listed price when the minimum blocks a one-unit price', async () => {
    // A wholesale-only product throws at qty 1; a wishlist entry is not an
    // order, so it must still render something.
    pricing.resolveUnitPrice.mockRejectedValue(new Error('below minimum'));

    const result = await service.list(buyer, { page: 1, limit: 20 });

    expect(result.items[0]?.product.price).toBe('250.00');
  });

  it('sums variant stock for the inStock flag', async () => {
    const result = await service.list(buyer, { page: 1, limit: 20 });

    expect(result.items[0]?.product.inStock).toBe(true);
  });

  it('reports out of stock when every variant is empty', async () => {
    prisma.wishlistItem.findMany.mockResolvedValue([
      row({ product: { ...row().product, variants: [{ stock: 0 }] } }),
    ]);

    const result = await service.list(buyer, { page: 1, limit: 20 });

    expect(result.items[0]?.product.inStock).toBe(false);
  });

  it('flags a product that has since been archived but keeps the row', async () => {
    prisma.wishlistItem.findMany.mockResolvedValue([
      row({ product: { ...row().product, status: ProductStatus.ARCHIVED } }),
    ]);

    const result = await service.list(buyer, { page: 1, limit: 20 });

    // The row is left in place; only its availability is reported.
    expect(result.items[0]?.product.available).toBe(false);
    expect(result.meta.total).toBe(1);
  });

  it('scopes the list to the current user', async () => {
    await service.list(buyer, { page: 1, limit: 20 });

    expect(prisma.wishlistItem.findMany.mock.calls[0][0].where).toEqual({
      userId: 'buyer-1',
    });
  });
});
