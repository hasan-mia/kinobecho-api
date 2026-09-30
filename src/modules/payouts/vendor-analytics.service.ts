import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  OrderStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { CommissionService } from './commission.service';
import { resolveWindow } from './dto/analytics.dto';

const ZERO = () => new Prisma.Decimal(0);

/**
 * Vendor-facing analytics: wallet balances, sales timeseries and low stock.
 *
 * Every query is scoped to `user.vendor.id` from the authenticated principal —
 * the vendor id is never read from the request — so a vendor cannot read a
 * competitor's figures by editing a path parameter.
 */
@Injectable()
export class VendorAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
  ) {}

  private requireVendor(user: AuthenticatedUser): string {
    if (!user.vendor) {
      throw new ForbiddenException('Only vendors have a wallet');
    }
    return user.vendor.id;
  }

  /**
   * Wallet balances.
   *
   * The buckets are deliberately *not* derived from one another, and are not a
   * partition of a single total:
   *
   * - `pendingBalance`     orders not yet DELIVERED, valued at the *current*
   *                        commission rate — an estimate, since no snapshot exists.
   * - `availableBalance`   DELIVERED orders with real snapshots that no PAYOUT
   *                        covers yet. This is the only figure a payout can draw on.
   * - `requestedBalance`   PENDING payouts already requested (not yet approved).
   * - `paidOut`            COMPLETED payouts.
   * - `lifetimeEarnings`   every DELIVERED order's snapshot, ever.
   *
   * All are returned as strings: a Decimal serialised by JSON would lose
   * precision, and these feed arithmetic in vendor dashboards.
   */
  async wallet(user: AuthenticatedUser) {
    const vendorId = this.requireVendor(user);

    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, commissionRate: true },
    });

    if (!vendor) {
      throw new ForbiddenException('Vendor not found');
    }

    // Orders already covered by a payout, in any state: an approved-but-unpaid
    // payout still owns its orders, so they must not also show as available.
    const settledOrderIds = await this.prisma.transactionOrder.findMany({
      where: { transaction: { vendorId, type: TransactionType.PAYOUT } },
      select: { orderId: true },
    });
    const settled = new Set(settledOrderIds.map((row) => row.orderId));

    const [pending, delivered] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          vendorId,
          // Cancelled orders are not receivable in any bucket, and delivered
          // orders are valued from their snapshot instead.
          status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
        },
        select: {
          subtotal: true,
          discountTotal: true,
          grandTotal: true,
        },
      }),
      this.prisma.order.findMany({
        where: { vendorId, status: OrderStatus.DELIVERED },
        select: { id: true, vendorEarning: true },
      }),
    ]);

    // Pending uses the live rate as an estimate; there is no snapshot to read.
    const pendingBalance = pending.reduce((sum, order) => {
      const estimate = this.commission.estimateForOrder(
        order,
        vendor.commissionRate,
      );
      return sum.add(estimate.vendorEarning);
    }, ZERO());

    const lifetimeEarnings = delivered.reduce(
      (sum, order) =>
        sum.add(
          order.vendorEarning === null ? ZERO() : new Prisma.Decimal(order.vendorEarning),
        ),
      ZERO(),
    );

    const availableBalance = delivered
      .filter((order) => !settled.has(order.id))
      .reduce(
        (sum, order) =>
          sum.add(
            order.vendorEarning === null
              ? ZERO()
              : new Prisma.Decimal(order.vendorEarning),
          ),
        ZERO(),
      );

    const payoutAggregates = await this.prisma.transaction.groupBy({
      by: ['status'],
      where: { vendorId, type: TransactionType.PAYOUT },
      _sum: { amount: true },
    });

    // Refunds on orders the vendor was *already* paid for leave the platform
    // owing them money, booked as a negative ADJUSTMENT. Only debts a later
    // payout has not yet netted off are outstanding; charging a settled one twice
    // would quietly over-deduct the vendor.
    const outstandingAdjustments = await this.prisma.transaction.aggregate({
      where: {
        vendorId,
        type: TransactionType.ADJUSTMENT,
        status: TransactionStatus.COMPLETED,
        // `offsetByPayout: null` is the "not yet netted off" test: a debt a
        // payout has already absorbed is settled, not outstanding.
        offsetByPayout: null,
      },
      _sum: { amount: true },
    });

    const outstandingAdjustmentTotal =
      outstandingAdjustments._sum.amount ?? ZERO();

    // floored at zero: a debt larger than the balance is shown, not hidden.
    const adjustedAvailable = availableBalance.gte(outstandingAdjustmentTotal)
      ? availableBalance.sub(outstandingAdjustmentTotal)
      : ZERO();

    const byStatus = new Map(
      payoutAggregates.map((row) => [row.status, row._sum.amount ?? ZERO()]),
    );

    return {
      currency: 'BDT',
      pendingBalance: pendingBalance.toFixed(2),
      // `availableBalance` is net of unpaid refund debts, because that is the
      // amount `POST /payouts` will actually let the vendor draw on. The gross
      // figure is kept alongside so the deduction is visible, not silent.
      availableBalance: adjustedAvailable.toFixed(2),
      availableBalanceGross: availableBalance.toFixed(2),
      outstandingAdjustment: outstandingAdjustmentTotal.toFixed(2),
      paidOut: (byStatus.get(TransactionStatus.COMPLETED) ?? ZERO()).toFixed(2),
      requestedBalance: (byStatus.get(TransactionStatus.PENDING) ?? ZERO()).toFixed(2),
      lifetimeEarnings: lifetimeEarnings.toFixed(2),
    };
  }

  /**
   * Sales analytics over a date window.
   *
   * Revenue is `subtotal - discountTotal` (what the vendor actually sold for),
   * not `grandTotal`, so shipping charged to the buyer does not inflate a
   * vendor's apparent sales.
   */
  async analytics(
    user: AuthenticatedUser,
    query: { from?: string; to?: string; groupBy?: 'day' | 'week' | 'month' },
  ) {
    const vendorId = this.requireVendor(user);
    const { from, to } = resolveWindow(query.from, query.to);
    const groupBy = query.groupBy ?? 'day';

    const orders = await this.prisma.order.findMany({
      where: {
        vendorId,
        createdAt: { gte: from, lte: to },
        // Cancelled orders never count as sales.
        status: { not: OrderStatus.CANCELLED },
      },
      select: {
        id: true,
        status: true,
        subtotal: true,
        discountTotal: true,
        createdAt: true,
        items: { select: { productVariantId: true, qty: true, lineTotal: true } },
      },
    });

    const revenueOf = (order: (typeof orders)[number]) =>
      new Prisma.Decimal(order.subtotal).minus(order.discountTotal);

    const salesTotal = orders.reduce((sum, o) => sum.add(revenueOf(o)), ZERO());

    const buckets = new Map<string, { revenue: Prisma.Decimal; count: number }>();
    const statusCounts = new Map<string, number>();
    // Revenue attributed to a product via the product name snapshot on its items.
    const productRevenue = new Map<
      string,
      { productId: string; revenue: Prisma.Decimal; qty: number }
    >();

    for (const order of orders) {
      statusCounts.set(order.status, (statusCounts.get(order.status) ?? 0) + 1);

      const bucketKey = bucketLabel(order.createdAt, groupBy);
      const bucket = buckets.get(bucketKey) ?? { revenue: ZERO(), count: 0 };
      bucket.revenue = bucket.revenue.add(revenueOf(order));
      bucket.count += 1;
      buckets.set(bucketKey, bucket);

      for (const item of order.items) {
        const entry = productRevenue.get(item.productVariantId) ?? {
          productId: item.productVariantId,
          revenue: ZERO(),
          qty: 0,
        };
        entry.revenue = entry.revenue.add(item.lineTotal);
        entry.qty += item.qty;
        productRevenue.set(item.productVariantId, entry);
      }
    }

    const timeseries = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, data]) => ({
        bucket,
        salesTotal: data.revenue.toFixed(2),
        orderCount: data.count,
      }));

    const topProducts = [...productRevenue.entries()]
      .sort(([, a], [, b]) => b.revenue.comparedTo(a.revenue))
      .slice(0, 10)
      .map(([productVariantId, data]) => ({
        productVariantId,
        revenue: data.revenue.toFixed(2),
        qtySold: data.qty,
      }));

    const orderCount = orders.length;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy,
      salesTotal: salesTotal.toFixed(2),
      orderCount,
      avgOrderValue:
        orderCount === 0 ? '0.00' : salesTotal.div(orderCount).toFixed(2),
      timeseries,
      topProducts,
      orderCountByStatus: Object.fromEntries(statusCounts),
    };
  }

  /** Variants at or below their low-stock alert threshold. */
  async lowStock(user: AuthenticatedUser) {
    const vendorId = this.requireVendor(user);

    const variants = await this.prisma.productVariant.findMany({
      where: {
        product: { vendorId, deletedAt: null },
        // `lte` rather than `lt`: hitting the alert level exactly is a warning,
        // not a healthy stock count.
        stock: { lte: 5 },
      },
      select: {
        id: true,
        sku: true,
        stock: true,
        lowStockAlertAt: true,
        lowStockNotifiedAt: true,
        product: {
          select: { id: true, name: true, slug: true },
        },
      },
      orderBy: { stock: 'asc' },
    });

    // The threshold is per-variant, so the comparison is filtered in JS rather
    // than in the where clause.
    const low = variants.filter((v) => v.stock <= v.lowStockAlertAt);

    return low.map((variant) => ({
      variantId: variant.id,
      sku: variant.sku,
      name: variant.product.name,
      slug: variant.product.slug,
      stock: variant.stock,
      lowStockAlertAt: variant.lowStockAlertAt,
      notified: variant.lowStockNotifiedAt !== null,
    }));
  }

  /**
   * Platform-wide overview for the admin dashboard.
   *
   * GMV counts what buyers paid *including* shipping (that is the platform's
   * throughput), while commission sums the snapshotted `commissionAmount` — the
   * figure the platform actually booked. Deriving commission from GMV would
   * overstate it by the shipping the courier collects.
   */
  async platformOverview(query: { from?: string; to?: string }) {
    const { from, to } = resolveWindow(query.from, query.to);

    const [orders, users, vendorAgg] = await Promise.all([
      this.prisma.order.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: {
          grandTotal: true,
          commissionAmount: true,
          status: true,
          vendorId: true,
        },
      }),
      this.prisma.user.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.vendor.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          businessName: true,
          slug: true,
          orders: {
            where: { createdAt: { gte: from, lte: to }, status: { not: OrderStatus.CANCELLED } },
            select: { grandTotal: true, vendorEarning: true, commissionAmount: true },
          },
        },
      }),
    ]);

    const live = orders.filter((o) => o.status !== OrderStatus.CANCELLED);

    const gmv = live.reduce(
      (sum, o) => sum.add(new Prisma.Decimal(o.grandTotal)),
      ZERO(),
    );

    const commission = live.reduce(
      (sum, o) =>
        sum.add(
          o.commissionAmount === null
            ? ZERO()
            : new Prisma.Decimal(o.commissionAmount),
        ),
      ZERO(),
    );

    const topVendors = vendorAgg
      .map((vendor) => {
        const earnings = vendor.orders.reduce(
          (sum, o) =>
            sum.add(
              o.vendorEarning === null
                ? ZERO()
                : new Prisma.Decimal(o.vendorEarning),
            ),
          ZERO(),
        );

        return {
          vendorId: vendor.id,
          businessName: vendor.businessName,
          slug: vendor.slug,
          orderCount: vendor.orders.length,
          gmv: vendor.orders
            .reduce((sum, o) => sum.add(new Prisma.Decimal(o.grandTotal)), ZERO())
            .toFixed(2),
          vendorEarnings: earnings.toFixed(2),
        };
      })
      .sort((a, b) => Number(b.vendorEarnings) - Number(a.vendorEarnings))
      .slice(0, 10);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      gmv: gmv.toFixed(2),
      commissionEarned: commission.toFixed(2),
      orderCount: live.length,
      newUsers: users,
      topVendors,
    };
  }
}

/** Normalised UTC bucket label for a date. */
function bucketLabel(date: Date, groupBy: 'day' | 'week' | 'month'): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  if (groupBy === 'day') {
    return `${year}-${month}-${day}`;
  }

  if (groupBy === 'month') {
    return `${year}-${month}`;
  }

  // ISO week. The Thursday of the current week determines the year, which is what
  // keeps late-December/early-January weeks in the correct bucket instead of
  // rolling them into the wrong calendar year.
  const target = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);

  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));

  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
