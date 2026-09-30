import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Order, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { PaymentsService } from '../payments/payments.service';

/**
 * Status transitions follow the enum order:
 * PENDING -> CONFIRMED -> PROCESSING -> SHIPPED -> DELIVERED,
 * with CANCELLED reachable from PENDING/CONFIRMED only.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};

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

      // Cancelling returns the reserved stock to the variant pool.
      if (toStatus === OrderStatus.CANCELLED) {
        await this.restoreStock(tx, order);
      }

      // Delivery is when COD money is collected.
      if (toStatus === OrderStatus.DELIVERED) {
        await this.payments.settleCodOnDelivery(tx, order);
      }

      return updated;
    });
  }

  private async restoreStock(
    tx: Prisma.TransactionClient,
    order: Order,
  ) {
    const items = await tx.orderItem.findMany({
      where: { orderId: order.id },
      select: { productVariantId: true, qty: true },
    });

    for (const item of items) {
      await tx.productVariant.update({
        where: { id: item.productVariantId },
        data: { stock: { increment: item.qty } },
      });
    }
  }
}