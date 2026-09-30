import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  Prisma,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ALLOWED_TRANSITIONS } from './order-status.constants';

export interface CancelOrderResult {
  orderId: string;
  /** False when the order was already CANCELLED and nothing was written. */
  cancelled: boolean;
  restocked: { productVariantId: string; qty: number }[];
  couponReleased: boolean;
  transactionsFailed: number;
}

export interface CancelOrderOptions {
  /**
   * Only cancel if the order still has this status, re-checked inside the
   * transaction.
   *
   * The expiry sweep sets this to PENDING. Without it the sweep would happily
   * cancel an order whose payment webhook won the race, because
   * `CONFIRMED -> CANCELLED` is a legitimate manual cancellation — legality alone
   * cannot distinguish "vendor cancelled it" from "customer just paid".
   * A mismatch is a silent no-op, not an error: losing a race is the expected
   * outcome, not a failure.
   */
  requireStatus?: OrderStatus;
}

/**
 * The one place that cancels an order.
 *
 * Every cancellation route funnels through here: manual `PATCH /orders/:id/status`,
 * the unpaid-order expiry sweep, and any future admin/ops tooling. Keeping a single
 * implementation is what makes the side effects (restock, coupon release, failing
 * open payment rows) impossible to half-apply.
 *
 * The order is re-read *inside* the transaction rather than trusting the caller's
 * copy. Two callers can both observe `PENDING` concurrently — a payment webhook
 * confirming at the same moment the expiry sweep fires — and whoever commits second
 * must re-evaluate against the committed state instead of blindly restocking
 * inventory a customer just paid for.
 */
@Injectable()
export class OrderCancellationService {
  private readonly logger = new Logger(OrderCancellationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param actorId  `null` for system-initiated cancels (expiry sweep); the user id
   *                 for a human action, recorded on the status history row.
   * @param reason   Free text stored on the history row; defaults to a generic note.
   */
  async cancelOrder(
    orderId: string,
    actorId: string | null,
    reason?: string,
    options: CancelOrderOptions = {},
  ): Promise<CancelOrderResult> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });

      if (!order) {
        throw new NotFoundException(`Order ${orderId} not found`);
      }

      // Someone else moved the order on (a payment webhook, a vendor). The
      // caller's precondition is stale, so write nothing.
      if (options.requireStatus && order.status !== options.requireStatus) {
        return {
          orderId: order.id,
          cancelled: false,
          restocked: [],
          couponReleased: false,
          transactionsFailed: 0,
        };
      }

      // Idempotent: a repeat call must not restock twice or double-decrement the
      // coupon counter. This is the guard that makes the sweep safe to re-run.
      if (order.status === OrderStatus.CANCELLED) {
        return {
          orderId: order.id,
          cancelled: false,
          restocked: [],
          couponReleased: false,
          transactionsFailed: 0,
        };
      }

      if (!ALLOWED_TRANSITIONS[order.status].includes(OrderStatus.CANCELLED)) {
        throw new BadRequestException(
          `Cannot cancel order from status ${order.status}`,
        );
      }

      const restocked = await this.restoreStock(tx, order.id);

      // A coupon is only linked when a discount was actually applied, so the
      // guard on discountTotal keeps cancelled full-price orders from touching
      // the shared redemption counter.
      let couponReleased = false;
      if (order.couponId && order.discountTotal.gt(0)) {
        const { count } = await tx.coupon.updateMany({
          // `usedCount > 0` guard: never drive the counter negative if a previous
          // release already brought it to zero.
          where: { id: order.couponId, usedCount: { gt: 0 } },
          data: { usedCount: { decrement: 1 } },
        });
        couponReleased = count > 0;
      }

      // Close out any open gateway row so the ledger never shows a PENDING
      // payment against a cancelled order.
      const failed = await tx.transaction.updateMany({
        where: { orderId: order.id, status: TransactionStatus.PENDING },
        data: { status: TransactionStatus.FAILED },
      });

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.CANCELLED,
          // Clear the deadline: a cancelled order must never be picked up by the
          // expiry sweep again.
          expiresAt: null,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          note: reason ?? 'Order cancelled',
          changedById: actorId,
        },
      });

      return {
        orderId: order.id,
        cancelled: true,
        restocked,
        couponReleased,
        transactionsFailed: failed.count,
      };
    });
  }

  /**
   * Restores reserved stock, aggregated per variant.
   *
   * Aggregating first matters: several OrderItem rows can share one variant, and
   * a single `increment` per variant keeps this to one write per product instead of
   * one per line.
   */
  private async restoreStock(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{ productVariantId: string; qty: number }[]> {
    const grouped = await tx.orderItem.groupBy({
      by: ['productVariantId'],
      where: { orderId },
      _sum: { qty: true },
    });

    const restocked: { productVariantId: string; qty: number }[] = [];

    for (const row of grouped) {
      const qty = row._sum.qty ?? 0;
      if (qty <= 0) {
        continue;
      }

      await tx.productVariant.update({
        where: { id: row.productVariantId },
        data: { stock: { increment: qty } },
      });

      restocked.push({ productVariantId: row.productVariantId, qty });
    }

    return restocked;
  }
}
