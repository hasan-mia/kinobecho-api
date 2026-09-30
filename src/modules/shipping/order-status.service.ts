import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Order,
  OrderStatus,
  Prisma,
  TransactionDirection,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { PaymentsService } from '../payments/payments.service';
import { OrderCancellationService } from '../orders/order-cancellation.service';
import { CommissionService } from '../payouts/commission.service';
import { SearchSyncService } from '../search/search-sync.service';

/**
 * Status transitions follow the enum order:
 * PENDING -> CONFIRMED -> PROCESSING -> SHIPPED -> DELIVERED,
 * with CANCELLED reachable from PENDING/CONFIRMED only.
 */
export { ALLOWED_TRANSITIONS } from '../orders/order-status.constants';

import { ALLOWED_TRANSITIONS } from '../orders/order-status.constants';

export interface MoveOrderStatusOptions {
  note?: string;
  /** Overrides the actor recorded on the history row (used by webhooks). */
  actorId?: string | null;
}

/**
 * Single place that mutates Order.status.
 *
 * Both the orders controller and the shipping webhooks drive status changes, and
 * the webhook path must not be blocked by the vendor/ownership checks that guard
 * a human-initiated update — hence `moveToSystem`, which validates only the
 * transition itself.
 */
@Injectable()
export class OrderStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly cancellation: OrderCancellationService,
    private readonly commission: CommissionService,
    private readonly search: SearchSyncService,
  ) {}

  /** Vendor- or admin-initiated change; enforces ownership. */
  async moveTo(
    user: AuthenticatedUser,
    orderId: string,
    toStatus: OrderStatus,
    options: MoveOrderStatusOptions = {},
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const isAdmin =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;

    if (!isAdmin && (!user.vendor || user.vendor.id !== order.vendorId)) {
      throw new ForbiddenException('You can only update your own orders');
    }

    return this.apply(order, toStatus, options.actorId ?? user.id, options.note);
  }

  /**
   * System-initiated change (courier webhook, scheduler). Skips the ownership
   * check but still validates the transition and always writes history.
   */
  async moveToSystem(
    user: AuthenticatedUser | undefined,
    orderId: string,
    toStatus: OrderStatus,
    options: MoveOrderStatusOptions = {},
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return this.apply(order, toStatus, options.actorId ?? null, options.note);
  }

  private async apply(
    order: Order,
    toStatus: OrderStatus,
    actorId: string | null,
    note?: string,
  ) {
    if (order.status === toStatus) {
      throw new BadRequestException(`Order is already ${toStatus}`);
    }

    if (!ALLOWED_TRANSITIONS[order.status].includes(toStatus)) {
      throw new BadRequestException(
        `Cannot change order status from ${order.status} to ${toStatus}`,
      );
    }

    // Cancellation owns more than the status flip — restock, coupon release and
    // failing open payment rows — so it is delegated to the single service that
    // guarantees all of it happens together. That service re-reads the order
    // inside its own transaction, so the state checked above may be stale by the
    // time it commits; its re-read is the authoritative one.
    if (toStatus === OrderStatus.CANCELLED) {
      await this.cancellation.cancelOrder(
        order.id,
        actorId,
        note ?? 'Order cancelled',
      );

      // Preserve the contract that a status change resolves to the updated order.
      return this.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: toStatus },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus,
          note,
          changedById: actorId,
        },
      });

      if (toStatus === OrderStatus.DELIVERED) {
        // Four effects, one transaction: COD is collected, the commission is
        // snapshotted, the popular-sell counter moves, and the search index is
        // queued. A delivered order must never lack its commission figures, or a
        // payout against it would be computed from whatever the rate happens to
        // be on the day of the request.
        await this.payments.settleCodOnDelivery(tx, order);
        await this.snapshotCommission(tx, order);
        const productIds = await this.recordSold(tx, order);
        this.notifySearch(productIds);
      }

      return updated;
    });
  }

  /**
   * Adds the order's units to each product's `soldCount`.
   *
   * Grouped per product, not per line: an order with three variants of the same
   * product must count three units, and counting per line would be right only by
   * accident. Inside the delivery transaction, so the counter cannot be
   * incremented for an order that failed to become DELIVERED.
   *
   * Not decremented on a return. The units were genuinely sold and paid for; a
   * refund does not un-sell them, and decrementing would make a returned product
   * disappear from "popular" for a reason no shopper asked about.
   */
  private async recordSold(
    tx: Prisma.TransactionClient,
    order: Order,
  ): Promise<string[]> {
    const items = await tx.orderItem.findMany({
      where: { orderId: order.id },
      select: { productVariantId: true, qty: true, productVariant: { select: { productId: true } } },
    });

    const byProduct = new Map<string, number>();

    for (const item of items) {
      const productId = item.productVariant.productId;
      byProduct.set(productId, (byProduct.get(productId) ?? 0) + item.qty);
    }

    for (const [productId, qty] of byProduct) {
      await tx.product.update({
        where: { id: productId },
        data: { soldCount: { increment: qty } },
      });
    }

    return [...byProduct.keys()];
  }

  /**
   * Queues the affected products for re-indexing.
   *
   * After the transaction commits, never inside it: the queue write is a network
   * call, and holding row locks across it would turn a slow Redis into a stuck
   * checkout. A failed enqueue only leaves a stale ranking until the next
   * reindex.
   */
  private notifySearch(productIds: string[]): void {
    for (const productId of new Set(productIds)) {
      void this.search.enqueueUpsert(productId);
    }
  }

  /**
   * Freezes the vendor's commission onto the order and books the matching
   * ledger row.
   *
   * The rate is read from `vendor.commissionRate` *at this moment* and stored on
   * the order. Later edits to the vendor's rate therefore cannot retroactively
   * change what this order earned, and the COMMISSION transaction is written
   * from the same snapshot rather than recomputed at payout time.
   */
  private async snapshotCommission(
    tx: Prisma.TransactionClient,
    order: Order,
  ): Promise<void> {
    // Already snapshotted: a re-delivery or a retried transition must not
    // create a second COMMISSION row.
    if (order.commissionAmount !== null) {
      return;
    }

    const vendor = await tx.vendor.findUnique({
      where: { id: order.vendorId },
      select: { id: true, commissionRate: true },
    });

    if (!vendor) {
      return;
    }

    const breakdown = this.commission.calculate({
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      commissionRate: vendor.commissionRate,
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        commissionRate: breakdown.commissionRate,
        commissionAmount: breakdown.commissionAmount,
        vendorEarning: breakdown.vendorEarning,
      },
    });

    await tx.transaction.create({
      data: {
        type: TransactionType.COMMISSION,
        direction: TransactionDirection.CREDIT,
        status: TransactionStatus.COMPLETED,
        amount: breakdown.commissionAmount,
        currency: 'BDT',
        fromType: 'VENDOR',
        fromId: order.vendorId,
        toType: 'PLATFORM',
        toId: null,
        orderId: order.id,
        vendorId: order.vendorId,
        note: `Commission on order ${order.orderNumber}`,
        completedAt: new Date(),
      },
    });
  }
}