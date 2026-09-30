import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, SaleType, UserRole } from '@prisma/client';
import { OrderSplitterService } from '../src/modules/orders/order-splitter.service';
import { PrismaService } from '../src/database/prisma.service';
import { ProductPricingService } from '../src/modules/product/pricing/product-pricing.service';

const dec = (v: string) => new Prisma.Decimal(v);

const saleItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'fsi-1',
  perUserLimit: 1,
  stockLimit: 10,
  soldCount: 0,
  ...overrides,
});

/**
 * A transaction stub whose `updateMany` records the guards it was called with
 * and can be made to fail, which is how the two oversell paths are exercised
 * without a real database.
 */
function build({
  items = [saleItem()],
  alreadyBought = 0,
  updateManyCount = 1,
  prismaPrice = dec('299.00'),
  qty = 1,
} = {}) {
  const updateManyCalls: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];

  const tx = {
    productVariant: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    flashSaleItem: {
      findUnique: vi.fn().mockResolvedValue(items[0]),
      updateMany: vi.fn().mockImplementation(async (args: any) => {
        updateManyCalls.push(args);
        return { count: updateManyCount };
      }),
    },
    orderItem: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { qty: alreadyBought } }),
    },
    order: {
      create: vi.fn().mockResolvedValue({ id: 'order-1' }),
      // generateOrderNumber probes for a collision before committing.
      findUnique: vi.fn().mockResolvedValue(null),
    },
    orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    shippingZone: { findFirst: vi.fn().mockResolvedValue(null) },
    coupon: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    cartItem: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };

  const prisma = {
    address: { findFirst: vi.fn().mockResolvedValue({ id: 'addr-1', userId: 'buyer-1' }) },
    cart: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'cart-1',
        userId: 'buyer-1',
        items: [
          {
            id: 'ci-1',
            productId: 'p1',
            productVariantId: 'v-1',
            qty,
            product: {
              id: 'p1',
              name: 'Widget',
              vendorId: 'vendor-1',
              weightGrams: 500,
              saleType: SaleType.RETAIL,
              minOrderQty: null,
            },
            productVariant: { id: 'v-1', stock: 50, attributes: {} },
          },
        ],
      }),
    },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(tx) : Promise.all(arg),
    ),
  };

  const service = new OrderSplitterService(
    prisma as unknown as PrismaService,
    {
      resolveWithContext: vi.fn().mockResolvedValue({
        unitPrice: prismaPrice,
        flashSaleItemId: 'fsi-1',
      }),
    } as unknown as ProductPricingService,
    {
      validateForSubtotal: vi.fn(),
      incrementUsage: vi.fn(),
    } as never,
    { calculateFee: vi.fn().mockResolvedValue({ fee: dec('60.00') }) } as never,
    { get: vi.fn().mockReturnValue(30) } as never,
    { checkAfterStockChange: vi.fn() } as never,
  );

  return { service, tx, updateManyCalls, prisma };
}

const checkoutDto = { addressId: 'addr-1' } as never;

describe('Checkout — flash sale budget is claimed atomically', () => {
  it('claims the units with a conditional update', async () => {
    const { service, updateManyCalls } = build();

    await service.splitCartIntoOrders('buyer-1', checkoutDto);

    const claim = updateManyCalls.find((c) => c.where.id === 'fsi-1');

    expect(claim).toBeDefined();
    expect(claim!.data).toEqual({ soldCount: { increment: 1 } });

  });

  it('guards the update on the current soldCount', async () => {
    const { service, updateManyCalls } = build({
      items: [saleItem({ stockLimit: 10, soldCount: 4 })],
    });

    await service.splitCartIntoOrders('buyer-1', checkoutDto);

    // soldCount + qty <= stockLimit, rewritten as soldCount <= stockLimit - qty.
    // Prisma cannot compare two columns, so the bound is precomputed; because
    // the guard and the increment are one statement, Postgres evaluates it
    // against the locked current row.
    const claim = updateManyCalls.find((c) => c.where.id === 'fsi-1');
    expect(claim!.where.soldCount).toEqual({ lte: 9 });
  });

  it('rejects the checkout when the guard matched no row', async () => {
    // count 0 means another transaction took the units first.
    const { service } = build({ updateManyCount: 0 });

    await expect(
      service.splitCartIntoOrders('buyer-1', checkoutDto),
    ).rejects.toThrow(/sold out|Only \d+ unit/i);
  });

  it('does not create the order when the claim fails', async () => {
    const { service, tx } = build({ updateManyCount: 0 });

    await expect(
      service.splitCartIntoOrders('buyer-1', checkoutDto),
    ).rejects.toThrow();

    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('increments by the whole line quantity, not by one', async () => {
    const { service, updateManyCalls } = build({
      items: [saleItem({ perUserLimit: 5 })],
      qty: 3,
    });

    await service.splitCartIntoOrders('buyer-1', checkoutDto);

    const claim = updateManyCalls.find((c) => c.where.id === 'fsi-1');
    expect(claim!.data).toEqual({ soldCount: { increment: 3 } });
  });

  it('bounds the guard by the full quantity, not by one', async () => {
    const { service, updateManyCalls } = build({
      items: [saleItem({ perUserLimit: 5, stockLimit: 10, soldCount: 4 })],
      qty: 3,
    });

    await service.splitCartIntoOrders('buyer-1', checkoutDto);

    // 4 + 3 <= 10, so the guard allows soldCount up to 7.
    const claim = updateManyCalls.find((c) => c.where.id === 'fsi-1');
    expect(claim!.where.soldCount).toEqual({ lte: 7 });
  });

  it('skips the claim entirely for an ordinary-priced line', async () => {
    const prismaStub = build();
    const spy = prismaStub.service as unknown as {
      pricing: ProductPricingService;
    };

    (
      spy.pricing.resolveWithContext as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ unitPrice: dec('500.00'), flashSaleItemId: null });

    await prismaStub.service.splitCartIntoOrders('buyer-1', checkoutDto);

    expect(
      prismaStub.updateManyCalls.find((c) => c.where.id === 'fsi-1'),
    ).toBeUndefined();
  });

  it('records the sale item on the order item so cancel can release it', async () => {
    const { service, tx } = build();

    await service.splitCartIntoOrders('buyer-1', checkoutDto);

    // Without this back-reference, a cancelled order's units would stay
    // consumed in the sale budget forever.
    expect(
      tx.order.create.mock.calls[0]![0].data.items.create[0].flashSaleItemId,
    ).toBe('fsi-1');
  });
});

describe('Checkout — perUserLimit', () => {
  it('counts the buyer units from prior non-cancelled orders', async () => {
    const { service, tx } = build({ alreadyBought: 0 });

    await service.splitCartIntoOrders('buyer-1', checkoutDto);

    const where = tx.orderItem.aggregate.mock.calls[0]![0].where;
    expect(where.flashSaleItemId).toBe('fsi-1');
    expect(where.order.buyerId).toBe('buyer-1');
    expect(where.order.status).toEqual({ not: 'CANCELLED' });
  });

  it('rejects once the buyer is at their limit', async () => {
    const { service, tx } = build({
      items: [saleItem({ perUserLimit: 2 })],
      alreadyBought: 2,
    });

    await expect(
      service.splitCartIntoOrders('buyer-1', checkoutDto),
    ).rejects.toThrow(/limit reached for "Widget"/);

    expect(tx.flashSaleItem.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a multi-unit line that would push the buyer past their limit', async () => {
    const { service } = build({
      items: [saleItem({ perUserLimit: 2 })],
      alreadyBought: 1,
      qty: 2,
    });

    // One already held plus a two-unit line exceeds a limit of two.
    await expect(
      service.splitCartIntoOrders('buyer-1', checkoutDto),
    ).rejects.toThrow(/only 1 more unit/i);
  });

  it('allows a line that lands exactly on the limit', async () => {
    const { service, tx } = build({
      items: [saleItem({ perUserLimit: 2 })],
      // One held plus a one-unit line is exactly the limit of two.
      alreadyBought: 1,
      qty: 1,
    });

    await expect(
      service.splitCartIntoOrders('buyer-1', checkoutDto),
    ).resolves.toBeDefined();
    expect(tx.flashSaleItem.updateMany).toHaveBeenCalled();
  });

  it('checks the buyer limit before the budget', async () => {
    // Both would fail; the buyer-limit message is the more actionable one and
    // it is also the cheaper query.
    const { service, tx } = build({
      items: [saleItem({ perUserLimit: 1, stockLimit: 1, soldCount: 1 })],
      alreadyBought: 1,
    });

    await expect(
      service.splitCartIntoOrders('buyer-1', checkoutDto),
    ).rejects.toThrow(/limit reached/);

    expect(tx.flashSaleItem.updateMany).not.toHaveBeenCalled();
  });

  it('does not count another buyer units', async () => {
    const { service, tx } = build({ alreadyBought: 0 });

    await service.splitCartIntoOrders('buyer-1', checkoutDto);

    // Scoped by buyerId, so the limit is per customer rather than platform-wide.
    expect(tx.orderItem.aggregate.mock.calls[0]![0].where.order.buyerId).toBe(
      'buyer-1',
    );
  });
});
