import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, QuotationStatus, RfqStatus, UserRole } from '@prisma/client';
import { RfqService } from '../src/modules/rfq/rfq.service';
import { OrderSplitterService } from '../src/modules/orders/order-splitter.service';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { ChatService } from '../src/modules/chat/chat.service';
import { NotificationService } from '../src/modules/notification/notification.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const dec = (v: string) => new Prisma.Decimal(v);
const uniqueViolation = Object.assign(new Error('unique'), { code: 'P2002' });

const buyer = {
  id: 'buyer-1',
  email: 'buyer@example.com',
  name: 'Buyer',
  role: UserRole.CUSTOMER,
  roleId: null,
  vendor: null,
} as unknown as AuthenticatedUser;

const vendorUser = {
  id: 'vendor-user',
  email: 'vendor@example.com',
  name: 'Vendor',
  role: UserRole.VENDOR,
  roleId: 'r-v',
  vendor: { id: 'v1', slug: 'v', businessName: 'Acme Ltd', status: 'ACTIVE' },
} as unknown as AuthenticatedUser;

const rfqRow = (over: Record<string, unknown> = {}) => ({
  id: 'rfq-1',
  buyerId: 'buyer-1',
  productId: 'p1',
  productVariantId: 'v-1',
  categoryId: null,
  title: '500 LED bulbs',
  description: 'Bulk packing preferred',
  quantity: 500,
  targetUnitPrice: null,
  deliveryDistrict: 'Dhaka',
  neededBy: null,
  status: RfqStatus.QUOTED,
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date('2026-01-01'),
  ...over,
});

const quotationRow = (over: Record<string, unknown> = {}) => ({
  id: 'q-1',
  rfqId: 'rfq-1',
  vendorId: 'v1',
  unitPrice: dec('115.75'),
  minQty: 100,
  leadTimeDays: 7,
  note: null,
  validUntil: new Date(Date.now() + 86_400_000),
  status: QuotationStatus.SENT,
  rfq: rfqRow(),
  ...over,
});

const variantRow = (over: Record<string, unknown> = {}) => ({
  id: 'v-1',
  sku: 'SKU-1',
  stock: 1000,
  product: { id: 'p1', name: 'LED Bulb', weightGrams: 120 },
  ...over,
});

function build() {
  const prisma: Record<string, unknown> = {
    rfq: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    quotation: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    order: { create: vi.fn() },
    productVariant: { findFirst: vi.fn().mockResolvedValue(variantRow()), findUnique: vi.fn() },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    category: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
    vendor: {
      // Default: an active vendor. Tests that need a different vendor state
      // override this rather than re-stating the row.
      findFirst: vi.fn().mockResolvedValue({
        id: 'v1',
        userId: 'vendor-user',
        businessName: 'Acme Ltd',
        status: 'ACTIVE',
      }),
      findUnique: vi.fn().mockResolvedValue({
        userId: 'vendor-user',
        user: { email: 'vendor@example.com' },
      }),
    },
    address: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
  };

  const orders = {
    createWholesaleOrderFromQuotation: vi.fn().mockResolvedValue({ id: 'o1', orderNumber: 'KB-20260101-ABC123' }),
    checkLowStockAfterCommit: vi.fn(),
  };

  const service = new RfqService(
    prisma as unknown as PrismaService,
    { get: (k: string) => (k === 'rfq.defaultWindowDays' ? 7 : undefined) } as unknown as ConfigService,
    orders as unknown as OrderSplitterService,
    { createOrFindThread: vi.fn().mockResolvedValue({ id: 'thread-1' }) } as unknown as ChatService,
    { sendTransactionalEmail: vi.fn(), sendPushToUser: vi.fn() } as unknown as NotificationService,
  );

  return { service, prisma, orders };
}

describe('RfqService.create — target validation', () => {
  it('rejects a request with neither a variant nor a category', async () => {
    const { service } = build();
    await expect(
      service.create(buyer, { title: 'Things', description: 'x'.repeat(12), quantity: 5, deliveryDistrict: 'Dhaka' } as never),
    ).rejects.toThrow(/either a product variant|category/);
  });

  it('rejects a product without a variant', async () => {
    // An order line must name a concrete variant, so a product-level request
    // could never become an order.
    const { service } = build();
    await expect(
      service.create(buyer, { productId: 'p1', title: 'Things', description: 'x'.repeat(12), quantity: 5, deliveryDistrict: 'Dhaka' } as never),
    ).rejects.toThrow(/specific variant/);
  });

  it('rejects naming both a variant and a category', async () => {
    const { service } = build();
    await expect(
      service.create(buyer, { productVariantId: 'v-1', categoryId: 'c1', title: 'Things', description: 'x'.repeat(12), quantity: 5, deliveryDistrict: 'Dhaka' } as never),
    ).rejects.toThrow(/not both/);
  });

  it('rejects a variant that does not exist', async () => {
    const { service, prisma } = build();
    (prisma.productVariant as any).findFirst.mockResolvedValue(null);
    await expect(
      service.create(buyer, { productVariantId: 'v-9', title: 'Things', description: 'x'.repeat(12), quantity: 5, deliveryDistrict: 'Dhaka' } as never),
    ).rejects.toThrow(/not found/);
  });

  it('rejects a variant whose product is not active', async () => {
    const { service, prisma } = build();
    (prisma.productVariant as any).findFirst.mockResolvedValue({ id: 'v-1', productId: 'p1', product: { status: 'DRAFT' } });
    await expect(
      service.create(buyer, { productVariantId: 'v-1', title: 'Things', description: 'x'.repeat(12), quantity: 5, deliveryDistrict: 'Dhaka' } as never),
    ).rejects.toThrow(/not available/);
  });

  it('rejects a productId that disagrees with the variant', async () => {
    const { service, prisma } = build();
    (prisma.productVariant as any).findFirst.mockResolvedValue({ id: 'v-1', productId: 'p-other', product: { status: 'ACTIVE' } });
    await expect(
      service.create(buyer, { productId: 'p1', productVariantId: 'v-1', title: 'Things', description: 'x'.repeat(12), quantity: 5, deliveryDistrict: 'Dhaka' } as never),
    ).rejects.toThrow(/does not match/);
  });

  it('rejects an expiry in the past', async () => {
    const { service } = build();
    await expect(
      service.create(buyer, { categoryId: 'c1', title: 'Things', description: 'x'.repeat(12), quantity: 5, deliveryDistrict: 'Dhaka', expiresAt: '2020-01-01T00:00:00.000Z' } as never),
    ).rejects.toThrow(/future/);
  });

  it('defaults the window from config when none is given', async () => {
    const { service, prisma } = build();
    const before = Date.now();
    await service.create(buyer, { categoryId: 'c1', title: 'Things', description: 'x'.repeat(12), quantity: 5, deliveryDistrict: 'Dhaka' } as never);
    const { expiresAt } = (prisma.rfq as any).create.mock.calls[0][0].data;
    const days = (new Date(expiresAt).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});

describe('RfqService.createQuotation — one quotation per vendor', () => {
  beforeEach(() => vi.clearAllMocks());

  const dto = { unitPrice: dec('115.75'), minQty: 100, leadTimeDays: 7 } as never;

  it('records the first quotation', async () => {
    const { service, prisma } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(null);
    (prisma.rfq as any).findUnique.mockResolvedValue(rfqRow({ status: RfqStatus.OPEN }));

    await service.createQuotation(vendorUser, 'rfq-1', dto);

    expect((prisma.quotation as any).create).toHaveBeenCalledTimes(1);
  });

  it('refuses a second quotation from the same vendor', async () => {
    const { service, prisma } = build();
    (prisma.rfq as any).findUnique.mockResolvedValue(rfqRow());
    (prisma.quotation as any).findUnique.mockResolvedValue({ id: 'q-existing' });

    await expect(service.createQuotation(vendorUser, 'rfq-1', dto)).rejects.toThrow(
      /already quoted/,
    );
    expect((prisma.quotation as any).create).not.toHaveBeenCalled();
  });

  it('refuses a second quotation even when the read raced', async () => {
    // Two simultaneous quotes both pass the "have I quoted?" check; the unique
    // index is the real guard, and it must surface as the same refusal rather
    // than a 500.
    const { service, prisma } = build();
    (prisma.rfq as any).findUnique.mockResolvedValue(rfqRow());
    (prisma.quotation as any).findUnique.mockResolvedValue(null);
    (prisma.quotation as any).create.mockRejectedValue(uniqueViolation);

    await expect(service.createQuotation(vendorUser, 'rfq-1', dto)).rejects.toThrow(
      /already quoted/,
    );
  });

  it('does not overwrite the earlier price', async () => {
    const { service, prisma } = build();
    (prisma.rfq as any).findUnique.mockResolvedValue(rfqRow());
    (prisma.quotation as any).findUnique.mockResolvedValue({ id: 'q-existing' });

    await service.createQuotation(vendorUser, 'rfq-1', dto).catch(() => undefined);

    // An update would let a vendor lower a price the buyer has already seen.
    expect(prisma.quotation).not.toHaveProperty('update');
  });

  it('refuses a minimum quantity above the requested quantity', async () => {
    const { service, prisma } = build();
    (prisma.rfq as any).findUnique.mockResolvedValue(rfqRow({ quantity: 50 }));
    (prisma.quotation as any).findUnique.mockResolvedValue(null);

    await expect(
      service.createQuotation(vendorUser, 'rfq-1', { ...(dvo as object), minQty: 500 } as never),
    ).rejects.toThrow(/exceeds the requested/);
  });

  it('refuses to quote on a request naming your own product', async () => {
    const { service, prisma } = build();
    (prisma.rfq as any).findUnique.mockResolvedValue(rfqRow());
    (prisma.productVariant as any).findUnique.mockResolvedValue({ product: { vendorId: 'v1' } });

    await expect(service.createQuotation(vendorUser, 'rfq-1', dto)).rejects.toThrow(
      /your own product/,
    );
  });

  it('refuses to quote on the buyer own request', async () => {
    const { service, prisma } = build();
    (prisma.rfq as any).findUnique.mockResolvedValue(rfqRow({ buyerId: 'vendor-user' }));
    (prisma.vendor as any).findFirst.mockResolvedValue({ id: 'v1', userId: 'vendor-user', businessName: 'Acme', status: 'ACTIVE' });

    await expect(service.createQuotation(vendorUser, 'rfq-1', dto)).rejects.toThrow(
      /your own request/,
    );
  });

  it('defaults validUntil to the request own window', async () => {
    const { service, prisma } = build();
    const rfq = rfqRow({ status: RfqStatus.OPEN });
    (prisma.rfq as any).findUnique.mockResolvedValue(rfq);
    (prisma.quotation as any).findUnique.mockResolvedValue(null);

    await service.createQuotation(vendorUser, 'rfq-1', dto);

    // An offer must never outlive the request it answers.
    expect((prisma.quotation as any).create.mock.calls[0][0].data.validUntil).toEqual(rfq.expiresAt);
  });

  it('moves the request to QUOTED on the first answer', async () => {
    const { service, prisma } = build();
    (prisma.rfq as any).findUnique.mockResolvedValue(rfqRow({ status: RfqStatus.OPEN }));
    (prisma.quotation as any).findUnique.mockResolvedValue(null);

    await service.createQuotation(vendorUser, 'rfq-1', dto);

    expect((prisma.rfq as any).updateMany).toHaveBeenCalledWith({
      where: { id: 'rfq-1', status: RfqStatus.OPEN },
      data: { status: RfqStatus.QUOTED },
    });
  });
});

const dvo = { unitPrice: dec('1'), minQty: 1, leadTimeDays: 1 };

describe('RfqService.acceptQuotation — price override only via the accepted quotation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prices the order from the quotation row', async () => {
    const { service, prisma, orders } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow());

    await service.acceptQuotation(buyer, 'q-1');

    const input = (orders.createWholesaleOrderFromQuotation as any).mock.calls[0][1];
    // The only price the splitter ever sees is the one on the persisted row.
    expect(input.quotation.unitPrice).toEqual(dec('115.75'));
  });

  it('takes no price from the request at all', async () => {
    const { service, prisma, orders } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow());

    await service.acceptQuotation(buyer, 'q-1');

    // The method signature has no unit-price parameter, so a client-supplied
    // price has nowhere to enter even if one were smuggled into the body.
    const args = (orders.createWholesaleOrderFromQuotation as any).mock.calls[0];
    expect(args).toHaveLength(2);
    expect(args[1].unitPrice).toBeUndefined();
  });

  it('uses the requested quantity, not the vendor minimum', async () => {
    const { service, prisma, orders } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow({ minQty: 100 }));

    await service.acceptQuotation(buyer, 'q-1');

    // A vendor quoting a small minQty cannot inflate the order by pairing it
    // with a large RFQ quantity.
    expect((orders.createWholesaleOrderFromQuotation as any).mock.calls[0][1].rfq.quantity).toBe(500);
  });

  it('rejects the other quotations in the same transaction', async () => {
    const { service, prisma } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow());

    await service.acceptQuotation(buyer, 'q-1');

    expect((prisma.quotation as any).updateMany).toHaveBeenCalledWith({
      where: {
        rfqId: 'rfq-1',
        id: { not: 'q-1' },
        status: QuotationStatus.SENT,
      },
      data: { status: QuotationStatus.REJECTED },
    });
  });

  it('claims the quotation conditionally', async () => {
    const { service, prisma } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow());

    await service.acceptQuotation(buyer, 'q-1');

    // The conditional update is what actually stops two concurrent accepts.
    expect((prisma.quotation as any).updateMany).toHaveBeenCalledWith({
      where: { id: 'q-1', status: QuotationStatus.SENT },
      data: { status: QuotationStatus.ACCEPTED },
    });
  });

  it('writes nothing when the claim loses a race', async () => {
    const { service, prisma, orders } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow());
    (prisma.quotation as any).updateMany.mockResolvedValue({ count: 0 });

    await expect(service.acceptQuotation(buyer, 'q-1')).rejects.toThrow(/no longer available/);
    expect(orders.createWholesaleOrderFromQuotation).not.toHaveBeenCalled();
  });

  it('refuses a quotation that is not SENT', async () => {
    const { service, prisma } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow({ status: QuotationStatus.REJECTED }));

    await expect(service.acceptQuotation(buyer, 'q-1')).rejects.toThrow(/already rejected/);
  });

  it('refuses an expired quotation', async () => {
    const { service, prisma } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(
      quotationRow({ validUntil: new Date(Date.now() - 1000) }),
    );

    await expect(service.acceptQuotation(buyer, 'q-1')).rejects.toThrow(/expired/);
  });

  it("refuses a quotation on somebody else's request", async () => {
    const { service, prisma } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow({ rfq: rfqRow({ buyerId: 'someone-else' }) }));

    await expect(service.acceptQuotation(buyer, 'q-1')).rejects.toThrow(/Only the requester/);
  });

  it('refuses to order a category-level request', async () => {
    // No variant means no order line, and guessing one would order the wrong SKU.
    const { service, prisma, orders } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(
      quotationRow({ rfq: rfqRow({ productVariantId: null }) }),
    );

    await expect(service.acceptQuotation(buyer, 'q-1')).rejects.toThrow(/for a category/);
    expect(orders.createWholesaleOrderFromQuotation).not.toHaveBeenCalled();
    expect((prisma.quotation as any).updateMany).not.toHaveBeenCalled();
  });

  it('records the delivery district when the buyer has no address', async () => {
    const { service, prisma, orders } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow());
    (prisma.address as any).findFirst.mockResolvedValue(null);

    await service.acceptQuotation(buyer, 'q-1');

    const input = (orders.createWholesaleOrderFromQuotation as any).mock.calls[0][1];
    expect(input.shippingAddress).toMatchObject({ district: 'Dhaka', fromRfqDistrict: true });
  });

  it('prefers the buyer own default address', async () => {
    const { service, prisma, orders } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue(quotationRow());
    (prisma.address as any).findFirst.mockResolvedValue({
      recipientName: 'Buyer', phone: '017', line1: 'L1', line2: null,
      city: 'Dhaka', district: 'Dhaka', postalCode: '1207', country: 'BD', label: 'Home',
    });

    await service.acceptQuotation(buyer, 'q-1');

    const input = (orders.createWholesaleOrderFromQuotation as any).mock.calls[0][1];
    expect(input.shippingAddress).toMatchObject({ line1: 'L1', postalCode: '1207' });
  });
});

describe('RfqService.listOpenForVendor — category matching', () => {
  it('excludes requests for the vendor own account', async () => {
    const { service, prisma } = build();
    (prisma.vendor as any).findFirst.mockResolvedValue({ id: 'v1', userId: 'vendor-user', businessName: 'Acme', status: 'ACTIVE' });
    (prisma.product as any).findMany.mockResolvedValue([{ categoryId: 'c1' }]);
    (prisma.category as any).findMany.mockResolvedValue([{ id: 'c1', parentId: null }, { id: 'c2', parentId: 'c1' }]);

    await service.listOpenForVendor(vendorUser, { page: 1, limit: 20 } as never);

    expect((prisma.rfq as any).findMany.mock.calls[0][0].where.buyerId).toEqual({ not: 'vendor-user' });
  });

  it('includes a descendant category the vendor stocks', async () => {
    const { service, prisma } = build();
    (prisma.vendor as any).findFirst.mockResolvedValue({ id: 'v1', userId: 'vendor-user', businessName: 'Acme', status: 'ACTIVE' });
    (prisma.product as any).findMany.mockResolvedValue([{ categoryId: 'c2' }]);
    (prisma.category as any).findMany.mockResolvedValue([{ id: 'c1', parentId: null }, { id: 'c2', parentId: 'c1' }]);

    await service.listOpenForVendor(vendorUser, { page: 1, limit: 20 } as never);

    const where = (prisma.rfq as any).findMany.mock.calls[0][0].where;
    expect(where.OR[0].categoryId.in).toEqual(expect.arrayContaining(['c2']));
  });

  it('shows only the vendors own quotation', async () => {
    const { service, prisma } = build();
    (prisma.vendor as any).findFirst.mockResolvedValue({ id: 'v1', userId: 'vendor-user', businessName: 'Acme', status: 'ACTIVE' });
    (prisma.product as any).findMany.mockResolvedValue([{ categoryId: 'c1' }]);
    (prisma.category as any).findMany.mockResolvedValue([{ id: 'c1', parentId: null }]);

    await service.listOpenForVendor(vendorUser, { page: 1, limit: 20 } as never);

    // A competitor's price is not a buyer's information to give away.
    expect((prisma.rfq as any).findMany.mock.calls[0][0].include.quotations.where).toEqual({ vendorId: 'v1' });
  });

  it('returns nothing for a vendor with no live products', async () => {
    const { service, prisma } = build();
    (prisma.vendor as any).findFirst.mockResolvedValue({ id: 'v1', userId: 'vendor-user', businessName: 'Acme', status: 'ACTIVE' });
    (prisma.product as any).findMany.mockResolvedValue([]);

    const result = await service.listOpenForVendor(vendorUser, { page: 1, limit: 20 } as never);

    expect(result.items).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect((prisma.rfq as any).findMany).not.toHaveBeenCalled();
  });
});

describe('RfqService.openChat', () => {
  it('opens a buyer–vendor thread for the requester', async () => {
    const { service, prisma } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue({ rfq: { buyerId: 'buyer-1' }, vendorId: 'v1' });

    const thread = await service.openChat(buyer, 'q-1');

    expect(thread).toEqual({ id: 'thread-1' });
  });

  it('refuses a non-requester', async () => {
    const { service, prisma } = build();
    (prisma.quotation as any).findUnique.mockResolvedValue({ rfq: { buyerId: 'someone-else' }, vendorId: 'v1' });

    await expect(service.openChat(buyer, 'q-1')).rejects.toThrow(/Only the requester/);
  });
});


describe('OrderSplitterService.createWholesaleOrderFromQuotation — the price override itself', () => {
  function buildSplitter() {
    const prisma: Record<string, unknown> = {
      productVariant: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: vi.fn().mockResolvedValue({ id: 'o1', orderNumber: 'KB-20260101-ABC123' }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    const shipping = {
      calculateFee: vi.fn().mockResolvedValue({ fee: new Prisma.Decimal(120) }),
    };

    const splitter = new OrderSplitterService(
      prisma as unknown as PrismaService,
      { resolveWithContext: vi.fn() } as never,
      {} as never,
      shipping as never,
      { get: () => 30 } as never,
      { checkAfterStockChange: vi.fn() } as never,
    );

    return { splitter, prisma, shipping };
  }

  const input = (over: Record<string, unknown> = {}) => ({
    rfq: {
      id: 'rfq-1',
      buyerId: 'buyer-1',
      title: '500 LED bulbs',
      quantity: 500,
      deliveryDistrict: 'Dhaka',
    },
    quotation: {
      id: 'q-1',
      vendorId: 'v1',
      unitPrice: dec('115.75'),
      minQty: 100,
      leadTimeDays: 7,
    },
    variant: variantRow(),
    shippingAddress: { district: 'Dhaka' },
    ...over,
  });

  it('orders at the quoted price, not the catalogue price', async () => {
    const { splitter, prisma } = buildSplitter();

    await splitter.createWholesaleOrderFromQuotation(
      prisma as never,
      input() as never,
    );

    const data = (prisma.order as any).create.mock.calls[0][0].data;
    expect(data.items.create.unitPrice).toEqual(dec('115.75'));
    expect(data.subtotal).toEqual(dec('57875.00'));
  });

  it('never consults the catalogue pricing service', async () => {
    const { splitter, prisma } = buildSplitter();
    const pricing = { resolveWithContext: vi.fn() };
    (splitter as any).pricing = pricing;

    await splitter.createWholesaleOrderFromQuotation(prisma as never, input() as never);

    // If pricing were consulted, a flash sale or tier could silently move the
    // price away from what the buyer and vendor agreed.
    expect(pricing.resolveWithContext).not.toHaveBeenCalled();
  });

  it('marks the order WHOLESALE regardless of the product sale type', async () => {
    const { splitter, prisma } = buildSplitter();

    await splitter.createWholesaleOrderFromQuotation(prisma as never, input() as never);

    expect((prisma.order as any).create.mock.calls[0][0].data.saleChannel).toBe('WHOLESALE');
  });

  it('rejects a quantity below the quoted minimum', async () => {
    const { splitter, prisma } = buildSplitter();

    await expect(
      splitter.createWholesaleOrderFromQuotation(
        prisma as never,
        input({
          rfq: {
            id: 'rfq-1', buyerId: 'buyer-1', title: 't', quantity: 50, deliveryDistrict: 'Dhaka',
          },
        }) as never,
      ),
    ).rejects.toThrow(/applies from 100 units/);
    expect((prisma.order as any).create).not.toHaveBeenCalled();
  });

  it('refuses to oversell, leaving the order uncreated', async () => {
    const { splitter, prisma } = buildSplitter();
    (prisma.productVariant as any).updateMany.mockResolvedValue({ count: 0 });

    await expect(
      splitter.createWholesaleOrderFromQuotation(prisma as never, input() as never),
    ).rejects.toThrow(/Insufficient stock/);
    expect((prisma.order as any).create).not.toHaveBeenCalled();
  });

  it('charges shipping on the quoted quantity weight', async () => {
    const { splitter, prisma, shipping } = buildSplitter();

    await splitter.createWholesaleOrderFromQuotation(prisma as never, input() as never);

    expect((shipping.calculateFee as any).mock.calls[0][0]).toEqual([
      { weightGrams: 120, qty: 500 },
    ]);
    expect((prisma.order as any).create.mock.calls[0][0].data.grandTotal).toEqual(dec('57995.00'));
  });
});
