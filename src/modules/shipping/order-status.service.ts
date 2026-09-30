import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Order, OrderStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { PaymentsService } from '../payments/payments.service';
import { OrderCancellationService } from '../orders/order-cancellation.service';

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

      // Delivery is when COD money is collected.
      if (toStatus === OrderStatus.DELIVERED) {
        await this.payments.settleCodOnDelivery(tx, order);
      }

      return updated;
    });
  }
}