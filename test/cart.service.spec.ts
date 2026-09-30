import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma, ProductStatus, SaleType } from '@prisma/client';
import { CartService } from '../src/modules/cart/cart.service';
import { ProductPricingService } from '../src/modules/product/pricing/product-pricing.service';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Unit tests for CartService.addItem duplicate-row handling.
 * PrismaService is mocked; no database is involved.
 */
describe('CartService.addItem duplicate rows', () => {
  let prisma: {
    product: { findFirst: ReturnType<typeof vi.fn> };
    productVariant: { findUnique: ReturnType<typeof vi.fn> };
    cart: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    cartItem: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let pricing: { resolveForQuantity: ReturnType<typeof vi.fn> };
  let service: CartService;

  const buildProduct = (overrides: Record<string, unknown> = {}) => ({
    id: 'product-1',
    vendorId: 'vendor-1',
    categoryId: 'category-1',
    name: 'Cotton T-Shirt',
    slug: 'cotton-t-shirt',
    saleType: SaleType.RETAIL,
    status: ProductStatus.ACTIVE,
    price: new Prisma.Decimal('500.00'),
    minOrderQty: null,
    deletedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      product: { findFirst: vi.fn() },
      productVariant: { findUnique: vi.fn() },
      cart: { findUnique: vi.fn(), create: vi.fn() },
      cartItem: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    // Run the transaction callback against the same mock tree so the test can
    // assert on the individual operations it performs.
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));

    pricing = { resolveForQuantity: vi.fn().mockResolvedValue({ unitPrice: new Prisma.Decimal('500.00'), minOrderQty: null }) };

    service = new CartService(
      prisma as unknown as PrismaService,
      pricing as unknown as ProductPricingService,
    );
  });

  it('keeps one row and sums qty when the same variant-less product is added twice', async () => {
    const product = buildProduct();
    prisma.product.findFirst.mockResolvedValue(product);
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', userId: 'user-1' });
    prisma.cartItem.findMany.mockResolvedValue([]);

    const existing = {
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: null,
      qty: 2,
    };
    prisma.cartItem.findFirst.mockResolvedValue(existing);
    prisma.cartItem.update.mockResolvedValue({ ...existing, qty: 5 });
    prisma.cartItem.create.mockResolvedValue(existing);

    await service.addItem('user-1', { productId: 'product-1', qty: 3 });

    expect(prisma.cartItem.create).not.toHaveBeenCalled();
    expect(prisma.cartItem.update).toHaveBeenCalledTimes(1);
    expect(prisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { qty: 5 },
    });
  });

  it('looks the existing row up with an explicit null productVariantId', async () => {
    prisma.product.findFirst.mockResolvedValue(buildProduct());
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', userId: 'user-1' });
    prisma.cartItem.findMany.mockResolvedValue([]);
    prisma.cartItem.findFirst.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: null,
      qty: 1,
    });
    prisma.cartItem.update.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: null,
      qty: 2,
    });

    await service.addItem('user-1', { productId: 'product-1', qty: 1 });

    expect(prisma.cartItem.findFirst).toHaveBeenCalledWith({
      where: {
        cartId: 'cart-1',
        productId: 'product-1',
        productVariantId: null,
      },
    });
  });

  it('creates a single row when no matching row exists', async () => {
    prisma.product.findFirst.mockResolvedValue(buildProduct());
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', userId: 'user-1' });
    prisma.cartItem.findMany.mockResolvedValue([]);
    prisma.cartItem.findFirst.mockResolvedValue(null);
    prisma.cartItem.create.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: null,
      qty: 2,
    });

    await service.addItem('user-1', { productId: 'product-1', qty: 2 });

    expect(prisma.cartItem.create).toHaveBeenCalledTimes(1);
    expect(prisma.cartItem.create).toHaveBeenCalledWith({
      data: {
        cartId: 'cart-1',
        productId: 'product-1',
        productVariantId: null,
        qty: 2,
      },
    });
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('validates the WHOLESALE minimum against the final summed quantity', async () => {
    prisma.product.findFirst.mockResolvedValue(
      buildProduct({ saleType: SaleType.WHOLESALE, minOrderQty: 5 }),
    );
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', userId: 'user-1' });
    prisma.cartItem.findMany.mockResolvedValue([]);
    prisma.cartItem.findFirst.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: null,
      qty: 2,
    });

    // 2 + 2 = 4 < minOrderQty 5 -> must be rejected even though the request qty alone (2) is also under.
    await expect(
      service.addItem('user-1', { productId: 'product-1', qty: 2 }),
    ).rejects.toThrow('Minimum order quantity for this product is 5');

    expect(prisma.cartItem.update).not.toHaveBeenCalled();
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('accepts the increment when the final quantity reaches the WHOLESALE minimum', async () => {
    prisma.product.findFirst.mockResolvedValue(
      buildProduct({ saleType: SaleType.WHOLESALE, minOrderQty: 5 }),
    );
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', userId: 'user-1' });
    prisma.cartItem.findMany.mockResolvedValue([]);
    prisma.cartItem.findFirst.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: null,
      qty: 3,
    });
    prisma.cartItem.update.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: null,
      qty: 5,
    });

    await service.addItem('user-1', { productId: 'product-1', qty: 2 });

    expect(prisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { qty: 5 },
    });
  });

  it('checks variant stock against the final quantity, not just the request qty', async () => {
    prisma.product.findFirst.mockResolvedValue(buildProduct());
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', userId: 'user-1' });
    prisma.cartItem.findMany.mockResolvedValue([]);
    prisma.cartItem.findFirst.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: 'variant-1',
      qty: 6,
    });
    prisma.productVariant.findUnique.mockResolvedValue({
      id: 'variant-1',
      productId: 'product-1',
      stock: 8,
    });

    // Request qty is only 2 (well within stock) but the row already holds 6, so
    // the final 8 is exactly the remaining stock and must pass.
    await service.addItem('user-1', {
      productId: 'product-1',
      productVariantId: 'variant-1',
      qty: 2,
    });

    expect(prisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { qty: 8 },
    });
  });

  it('rejects when the summed quantity exceeds the variant stock', async () => {
    prisma.product.findFirst.mockResolvedValue(buildProduct());
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', userId: 'user-1' });
    prisma.cartItem.findMany.mockResolvedValue([]);
    prisma.cartItem.findFirst.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: 'variant-1',
      qty: 6,
    });
    prisma.productVariant.findUnique.mockResolvedValue({
      id: 'variant-1',
      productId: 'product-1',
      stock: 7,
    });

    await expect(
      service.addItem('user-1', {
        productId: 'product-1',
        productVariantId: 'variant-1',
        qty: 2,
      }),
    ).rejects.toThrow('Insufficient stock for the selected variant');

    expect(prisma.cartItem.update).not.toHaveBeenCalled();
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('runs the lookup and the write inside a transaction', async () => {
    prisma.product.findFirst.mockResolvedValue(buildProduct());
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', userId: 'user-1' });
    prisma.cartItem.findMany.mockResolvedValue([]);
    prisma.cartItem.findFirst.mockResolvedValue(null);
    prisma.cartItem.create.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      productVariantId: null,
      qty: 1,
    });

    await service.addItem('user-1', { productId: 'product-1', qty: 1 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.cartItem.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.cartItem.create.mock.invocationCallOrder[0]!,
    );
  });
});