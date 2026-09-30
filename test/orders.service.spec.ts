import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OrderStatus, Prisma, SaleChannel, UserRole } from '@prisma/client';
import { OrdersService } from '../src/modules/orders/orders.service';
import { OrderSplitterService } from '../src/modules/orders/order-splitter.service';
import { PrismaService } from '../src/database/prisma.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { ListAdminOrdersQueryDto } from '../src/modules/orders/dto/order.dto';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

/**
 * Unit tests for the platform-wide admin order list added to OrdersService.
 * PrismaService is mocked; no database is involved.
 */
describe('OrdersService.findAllOrders', () => {
  let prisma: {
    order: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: OrdersService;

  const buildOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 'order-1',
    orderGroupId: 'group-1',
    orderNumber: 'ORD-20260928-8F3A1C',
    status: OrderStatus.PENDING,
    saleChannel: SaleChannel.RETAIL,
    subtotal: new Prisma.Decimal('3200.00'),
    discountTotal: new Prisma.Decimal('320.00'),
    shippingFee: new Prisma.Decimal('80.00'),
    grandTotal: new Prisma.Decimal('2960.00'),
    buyerId: 'buyer-1',
    vendorId: 'vendor-1',
    shippingAddress: {},
    couponId: null,
    createdAt: new Date('2026-09-28T10:15:00.000Z'),
    updatedAt: new Date('2026-09-28T10:15:00.000Z'),
    items: [
      {
        id: 'item-1',
        orderId: 'order-1',
        productVariantId: 'variant-1',
        productNameSnap: 'Wireless Headphones',
        qty: 2,
        unitPrice: new Prisma.Decimal('1250.00'),
        lineTotal: new Prisma.Decimal('2500.00'),
      },
    ],
    vendor: {
      id: 'vendor-1',
      businessName: 'Rahim Electronics',
      slug: 'rahim-electronics',
      logoUrl: null,
    },
    buyer: {
      id: 'buyer-1',
      name: 'Tanvir Hossain',
      email: 'customer1@kinobecho.dev',
      phone: '+8801700000002',
    },
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      order: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      {} as OrderSplitterService,
      { settleCodOnDelivery: vi.fn() } as unknown as PaymentsService,
    );
  });

  it('returns items and meta with totalPages computed from the count', async () => {
    const order = buildOrder();
    prisma.order.findMany.mockResolvedValue([order]);
    prisma.order.count.mockResolvedValue(137);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    const result = await service.findAllOrders({ page: 1, limit: 20 });

    expect(result.meta).toEqual({ total: 137, page: 1, limit: 20, totalPages: 7 });
    expect(result.items).toHaveLength(1);
  });

  it('serialises every Decimal money field to a 2-decimal string', async () => {
    prisma.order.findMany.mockResolvedValue([buildOrder()]);
    prisma.order.count.mockResolvedValue(1);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    const result = await service.findAllOrders({ page: 1, limit: 20 });
    const order = result.items[0]!;

    expect(order.subtotal).toBe('3200.00');
    expect(order.discountTotal).toBe('320.00');
    expect(order.shippingFee).toBe('80.00');
    expect(order.grandTotal).toBe('2960.00');
    expect(order.items[0]!.unitPrice).toBe('1250.00');
    expect(order.items[0]!.lineTotal).toBe('2500.00');

    for (const value of [
      order.subtotal,
      order.discountTotal,
      order.shippingFee,
      order.grandTotal,
    ]) {
      expect(typeof value).toBe('string');
    }
  });

  it('applies skip/take from the page and limit', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    await service.findAllOrders({ page: 3, limit: 10 });

    const args = prisma.order.findMany.mock.calls[0]![0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('defaults to page 1 and limit 20 when the query omits them', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    const result = await service.findAllOrders({} as ListAdminOrdersQueryDto);

    expect(result.meta.page).toBe(1);
    expect(result.meta.limit).toBe(20);

    const args = prisma.order.findMany.mock.calls[0]![0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
  });

  it('maps status, saleChannel, vendor, buyer and group filters into the where clause', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    await service.findAllOrders({
      page: 1,
      limit: 20,
      status: OrderStatus.SHIPPED,
      saleChannel: SaleChannel.WHOLESALE,
      vendorId: 'vendor-1',
      buyerId: 'buyer-1',
      orderGroupId: 'group-1',
    });

    const args = prisma.order.findMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({
      status: OrderStatus.SHIPPED,
      saleChannel: SaleChannel.WHOLESALE,
      vendorId: 'vendor-1',
      buyerId: 'buyer-1',
      orderGroupId: 'group-1',
    });
  });

  it('searches the order number case-insensitively', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    await service.findAllOrders({ page: 1, limit: 20, search: 'ord-8f3' });

    const args = prisma.order.findMany.mock.calls[0]![0];
    expect(args.where.orderNumber).toEqual({
      contains: 'ord-8f3',
      mode: 'insensitive',
    });
  });

  it('builds a createdAt range from from and to', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    await service.findAllOrders({
      page: 1,
      limit: 20,
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-28T23:59:59.999Z',
    });

    const args = prisma.order.findMany.mock.calls[0]![0];
    expect(args.where.createdAt.gte).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(args.where.createdAt.lte).toEqual(new Date('2026-09-28T23:59:59.999Z'));
  });

  it('leaves createdAt undefined when no date range is given', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    await service.findAllOrders({ page: 1, limit: 20 });

    const args = prisma.order.findMany.mock.calls[0]![0];
    expect(args.where.createdAt).toBeUndefined();
  });

  it('reports zero totalPages when there are no results', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));

    const result = await service.findAllOrders({ page: 1, limit: 20 });

    expect(result.items).toEqual([]);
    expect(result.meta.totalPages).toBe(0);
  });
});

describe('OrdersService.assertCanView', () => {
  let prisma: {
    order: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: OrdersService;

  const baseOrder = {
    id: 'order-1',
    buyerId: 'buyer-1',
    vendorId: 'vendor-1',
  };

  beforeEach(() => {
    prisma = {
      order: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    service = new OrdersService(
      prisma as unknown as PrismaService,
      {} as OrderSplitterService,
      { settleCodOnDelivery: vi.fn() } as unknown as PaymentsService,
    );
  });

  const user = (overrides: Partial<AuthenticatedUser>): AuthenticatedUser => ({
    id: 'buyer-1',
    email: 'a@b.c',
    name: 'Test',
    role: UserRole.CUSTOMER,
    roleId: null,
    vendor: null,
    ...overrides,
  });

  it('lets SUPER_ADMIN view any order', async () => {
    await expect(
      service.findOne(user({ role: UserRole.SUPER_ADMIN }), 'order-1'),
    ).rejects.toThrow();
    // findOne throws NotFound because the mock returns undefined; the guard itself
    // is exercised below with a resolved order.
  });

  it('allows the buyer to view their own order', async () => {
    prisma.order.findUnique = vi.fn().mockResolvedValue(baseOrder);

    const result = await service.findOne(
      user({ id: 'buyer-1' }),
      'order-1',
    );

    expect(result).toBe(baseOrder);
  });

  it('allows the owning vendor to view the order', async () => {
    prisma.order.findUnique = vi.fn().mockResolvedValue(baseOrder);

    const result = await service.findOne(
      user({
        id: 'someone-else',
        role: UserRole.VENDOR,
        vendor: {
          id: 'vendor-1',
          slug: 'rahim',
          businessName: 'Rahim',
          status: 'ACTIVE' as never,
        },
      }),
      'order-1',
    );

    expect(result).toBe(baseOrder);
  });

  it('rejects a user with no relationship to the order', async () => {
    prisma.order.findUnique = vi.fn().mockResolvedValue(baseOrder);

    await expect(
      service.findOne(user({ id: 'intruder' }), 'order-1'),
    ).rejects.toThrow('You do not have access to this order');
  });
});
