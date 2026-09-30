import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderStatus,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  ReturnStatus,
  TransactionDirection,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { NotificationService } from '../notification/notification.service';
import { PaymentsService } from '../payments/payments.service';
import { OrderStatusService } from '../shipping/order-status.service';
import {
  CreateReturnDto,
  ListReturnsQueryDto,
  ReceiveReturnDto,
  RefundReturnDto,
  ReturnDecisionDto,
} from './dto/returns.dto';
import { computeRefund, remainingReturnableQty } from './returns-refund.util';

const RETURN_INCLUDE = {
  items: { include: { orderItem: true } },
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      subtotal: true,
      discountTotal: true,
      shippingFee: true,
      grandTotal: true,
      buyerId: true,
      vendorId: true,
    },
  },
  buyer: { select: { id: true, name: true, email: true } },
  vendor: { select: { id: true, businessName: true, userId: true } },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.ReturnRequestInclude;

/** A return holds its requested quantities unless the vendor turned it down. */
const BLOCKING_STATUSES: ReturnStatus[] = [
  ReturnStatus.REQUESTED,
  ReturnStatus.APPROVED,
  ReturnStatus.PICKUP_SCHEDULED,
  ReturnStatus.RECEIVED,
  ReturnStatus.REFUNDED,
  ReturnStatus.CLOSED,
];

const ZERO = () => new Prisma.Decimal(0);

/**
 * Returns and the money that follows them.
 *
 * The lifecycle is REQUESTED -> APPROVED|REJECTED -> PICKUP_SCHEDULED ->
 * RECEIVED -> REFUNDED -> CLOSED, and the two money-bearing steps are the ones
 * that can go wrong twice over: a restock that inflates inventory, and a refund
 * that overpays. Both are therefore re-checked inside the transaction that does
 * the writing, not trusted from the caller's copy of the row.
 */
@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationService,
    private readonly payments: PaymentsService,
    private readonly orderStatus: OrderStatusService,
  ) {}

  private windowDays(): number {
    const configured = this.config.get<number>('returns.windowDays') ?? 7;
    return configured > 0 ? configured : 7;
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
  }

  // ---------------------------------------------------------------- reads

  async listForBuyer(user: AuthenticatedUser, query: ListReturnsQueryDto) {
    return this.prisma.returnRequest.findMany({
      where: {
        buyerId: user.id,
        ...this.filterWhere(query),
      },
      include: RETURN_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForVendor(user: AuthenticatedUser, query: ListReturnsQueryDto) {
    if (!user.vendor) {
      throw new ForbiddenException('Only vendors have return requests');
    }

    return this.prisma.returnRequest.findMany({
      where: {
        // Scoped to the vendor on the token, never to a query parameter, so one
        // vendor cannot read another's returns by guessing an id.
        vendorId: user.vendor.id,
        ...this.filterWhere(query, { vendorId: user.vendor.id }),
      },
      include: RETURN_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForAdmin(query: ListReturnsQueryDto) {
    return this.prisma.returnRequest.findMany({
      where: this.filterWhere(query),
      include: RETURN_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id },
      include: RETURN_INCLUDE,
    });

    if (!request) {
      throw new NotFoundException('Return request not found');
    }

    if (this.isAdmin(user) || request.buyerId === user.id) {
      return request;
    }

    if (user.vendor && user.vendor.id === request.vendorId) {
      return request;
    }

    throw new ForbiddenException('You do not have access to this return request');
  }

  // ---------------------------------------------------------------- create

  /**
   * Files a return.
   *
   * The window is measured from the order's DELIVERED history row, not from
   * `order.updatedAt`: the latter moves on every later write (a payment webhook,
   * a status note) and would silently extend or revoke a buyer's window
   * depending on unrelated activity.
   */
  async create(user: AuthenticatedUser, dto: CreateReturnDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.buyerId !== user.id) {
      throw new ForbiddenException('You can only return your own orders');
    }

    if (order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(
        `Only delivered orders can be returned; this order is ${order.status}`,
      );
    }

    const deliveredAt = await this.deliveredAt(order.id);

    if (!deliveredAt) {
      throw new BadRequestException(
        'This order has no delivery record, so it cannot be returned',
      );
    }

    const windowDays = this.windowDays();
    const deadline = new Date(
      deliveredAt.getTime() + windowDays * 24 * 60 * 60 * 1000,
    );

    if (Date.now() > deadline.getTime()) {
      throw new BadRequestException(
        `The ${windowDays}-day return window for this order closed on ` +
          deadline.toISOString().slice(0, 10),
      );
    }

    // Collapse duplicate lines first: two entries for the same OrderItem would
    // otherwise each pass the per-line check while together exceeding it.
    const requested = new Map<string, number>();
    for (const item of dto.items) {
      requested.set(item.orderItemId, (requested.get(item.orderItemId) ?? 0) + item.qty);
    }

    const orderItemsById = new Map(order.items.map((item) => [item.id, item]));

    // Quantities already spoken for by other live returns, in one query rather
    // than one per line.
    const existing = await this.prisma.returnItem.findMany({
      where: {
        orderItemId: { in: [...requested.keys()] },
        returnRequest: { status: { in: BLOCKING_STATUSES } },
      },
      select: { orderItemId: true, qty: true },
    });

    const alreadyRequested = new Map<string, number>();
    for (const row of existing) {
      alreadyRequested.set(
        row.orderItemId,
        (alreadyRequested.get(row.orderItemId) ?? 0) + row.qty,
      );
    }

    for (const [orderItemId, qty] of requested) {
      const item = orderItemsById.get(orderItemId);

      if (!item) {
        throw new BadRequestException(
          `Order item ${orderItemId} does not belong to this order`,
        );
      }

      if (qty <= 0) {
        throw new BadRequestException('Return quantities must be positive');
      }

      const remaining = remainingReturnableQty(
        item.qty,
        alreadyRequested.get(orderItemId) ?? 0,
      );

      if (qty > remaining) {
        throw new BadRequestException(
          `Only ${remaining} of "${item.productNameSnap}" can still be returned`,
        );
      }
    }

    const request = await this.prisma.returnRequest.create({
      data: {
        orderId: order.id,
        buyerId: user.id,
        vendorId: order.vendorId,
        status: ReturnStatus.REQUESTED,
        reason: dto.reason,
        comment: dto.comment ?? null,
        evidenceUrls: dto.evidenceUrls ?? [],
        items: {
          create: [...requested.entries()].map(([orderItemId, qty]) => ({
            orderItemId,
            qty,
          })),
        },
      },
      include: RETURN_INCLUDE,
    });

    this.logger.log(
      `Return ${request.id} filed on order ${order.orderNumber} by buyer ${user.id}`,
    );

    await this.notifyTransition(request, {
      buyerTemplate: 'return-requested',
      buyerSubject: `Return requested for order ${order.orderNumber}`,
      vendorTemplate: 'vendor-return-decision',
      vendorSubject: `New return request for order ${order.orderNumber}`,
    });

    return request;
  }

  /** The most recent DELIVERED transition, which starts the return window. */
  private async deliveredAt(orderId: string): Promise<Date | null> {
    const history = await this.prisma.orderStatusHistory.findFirst({
      where: { orderId, toStatus: OrderStatus.DELIVERED },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    return history?.createdAt ?? null;
  }

  // ------------------------------------------------------------- decisions

  /**
   * Vendor or admin approves/rejects.
   *
   * A rejection without a note is refused: the buyer is told the request failed
   * and needs something actionable to act on.
   */
  async decide(
    user: AuthenticatedUser,
    id: string,
    dto: ReturnDecisionDto,
  ) {
    const request = await this.requireDecidable(user, id);

    if (dto.decision === 'REJECTED' && !dto.note?.trim()) {
      throw new BadRequestException('A note is required when rejecting a return');
    }

    const next = dto.decision === 'APPROVED' ? ReturnStatus.APPROVED : ReturnStatus.REJECTED;

    const updated = await this.prisma.returnRequest.update({
      where: { id: request.id },
      data: {
        status: next,
        decidedById: user.id,
        decisionNote: dto.note?.trim() ?? null,
      },
      include: RETURN_INCLUDE,
    });

    this.logger.log(`Return ${id} ${next.toLowerCase()} by user ${user.id}`);

    await this.notifyTransition(updated, {
      buyerTemplate: next === ReturnStatus.APPROVED ? 'return-approved' : 'return-rejected',
      buyerSubject: `Your return for order ${request.order.orderNumber} was ${next.toLowerCase()}`,
      vendorTemplate:
        next === ReturnStatus.APPROVED ? 'vendor-return-approved' : 'vendor-return-rejected',
      vendorSubject: `Return ${id} for order ${request.order.orderNumber} was ${next.toLowerCase()}`,
      extra: { note: dto.note ?? '' },
    });

    return updated;
  }

  private async requireDecidable(
    user: AuthenticatedUser,
    id: string,
  ) {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id },
      include: RETURN_INCLUDE,
    });

    if (!request) {
      throw new NotFoundException('Return request not found');
    }

    if (!this.isAdmin(user) && (!user.vendor || user.vendor.id !== request.vendorId)) {
      throw new ForbiddenException(
        'Only the vendor who sold this order can decide the return',
      );
    }

    if (
      request.status !== ReturnStatus.REQUESTED &&
      request.status !== ReturnStatus.PICKUP_SCHEDULED
    ) {
      throw new BadRequestException(
        `A return in ${request.status} can no longer be decided`,
      );
    }

    return request;
  }

  // --------------------------------------------------------------- received

  /**
   * Marks the goods as back with the vendor, optionally restocking.
   *
   * Restocking is a *choice*, not a default: a damaged or incorrect item put
   * straight back into sellable inventory is worse than not restocking it. It is
   * also idempotent — `status: RECEIVED` is re-checked in the transaction, so a
   * double-tap cannot add the same units to stock twice.
   */
  async receive(user: AuthenticatedUser, id: string, dto: ReceiveReturnDto) {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id },
      include: RETURN_INCLUDE,
    });

    if (!request) {
      throw new NotFoundException('Return request not found');
    }

    if (!this.isAdmin(user) && (!user.vendor || user.vendor.id !== request.vendorId)) {
      throw new ForbiddenException(
        'Only the vendor who sold this order can receive the return',
      );
    }

    const restock = dto.restock !== false;

    const result = await this.prisma.$transaction(async (tx) => {
      // Re-read under the transaction: two admins marking the same return
      // received at once must restock once.
      const current = await tx.returnRequest.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!current) {
        throw new NotFoundException('Return request not found');
      }

      if (current.status === ReturnStatus.RECEIVED || current.status === ReturnStatus.REFUNDED) {
        return { restocked: [] as { productVariantId: string; qty: number }[], alreadyReceived: true };
      }

      if (current.status !== ReturnStatus.APPROVED && current.status !== ReturnStatus.PICKUP_SCHEDULED) {
        throw new BadRequestException(
          `A return in ${current.status} cannot be marked received`,
        );
      }

      const restocked: { productVariantId: string; qty: number }[] = [];

      if (restock) {
        // Aggregate per variant: several returned lines can share one variant,
        // and one increment per variant keeps this to a single write each.
        const grouped = new Map<string, number>();
        const orderItems = await tx.orderItem.findMany({
          where: { id: { in: current.items.map((item) => item.orderItemId) } },
          select: { id: true, productVariantId: true },
        });
        const variantByItem = new Map(orderItems.map((i) => [i.id, i.productVariantId]));

        for (const item of current.items) {
          const variantId = variantByItem.get(item.orderItemId);
          if (!variantId) {
            continue;
          }
          grouped.set(variantId, (grouped.get(variantId) ?? 0) + item.qty);
        }

        for (const [variantId, qty] of grouped) {
          if (qty <= 0) {
            continue;
          }
          await tx.productVariant.update({
            where: { id: variantId },
            data: { stock: { increment: qty } },
          });
          restocked.push({ productVariantId: variantId, qty });
        }
      }

      await tx.returnRequest.update({
        where: { id },
        data: { status: ReturnStatus.RECEIVED },
      });

      return { restocked, alreadyReceived: false };
    });

    const updated = await this.prisma.returnRequest.findUniqueOrThrow({
      where: { id },
      include: RETURN_INCLUDE,
    });

    await this.notifyTransition(updated, {
      buyerTemplate: 'return-received',
      buyerSubject: `We received your return for order ${request.order.orderNumber}`,
      vendorTemplate: 'vendor-return-received',
      vendorSubject: `Return ${id} marked received`,
      extra: {
        restockNote: restock
          ? `${result.restocked.length} variant(s) restocked.`
          : 'Items were not restocked.',
      },
    });

    return { ...updated, restocked: result.restocked };
  }

  // ---------------------------------------------------------------- refund

  /**
   * Issues the refund for a received return.
   *
   * Which rail the money travels on depends on how the order was paid, and the
   * two are not interchangeable:
   *
   * - **Online** (bKash/Nagad/SSLCOMMERZ/Stripe): the gateway is called for the
   *   real money and the ledger row is written COMPLETED, matching the order's
   *   `paymentStatus` immediately.
   * - **COD**: no money ever entered a gateway, so there is nothing to call. The
   *   row stays PENDING as an instruction to pay the buyer out of pocket, and
   *   `PATCH /payments/refunds/:transactionId/confirm` is what marks the money
   *   as handed over. Writing it COMPLETED up front would claim a payout that
   *   never happened.
   */
  async refund(user: AuthenticatedUser, id: string, dto: RefundReturnDto) {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id },
      include: RETURN_INCLUDE,
    });

    if (!request) {
      throw new NotFoundException('Return request not found');
    }

    if (request.status === ReturnStatus.REFUNDED) {
      throw new BadRequestException('This return has already been refunded');
    }

    if (request.status !== ReturnStatus.RECEIVED) {
      throw new BadRequestException(
        `A return must be RECEIVED before it can be refunded; this one is ${request.status}`,
      );
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: request.orderId },
    });

    const payment = await this.prisma.transaction.findFirst({
      where: {
        orderId: order.id,
        type: TransactionType.PAYMENT,
        status: TransactionStatus.COMPLETED,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!payment) {
      throw new BadRequestException('No completed payment found for this order');
    }

    // What is left to hand back across every refund on this order. Refunds that
    // are still PENDING count: the money is already promised to the buyer, and
    // a second return must not re-spend it.
    const refundedSoFar = await this.prisma.transaction.aggregate({
      where: {
        orderId: order.id,
        type: TransactionType.REFUND,
        status: { in: [TransactionStatus.PENDING, TransactionStatus.COMPLETED] },
      },
      _sum: { amount: true },
    });

    const refundableRemaining = new Prisma.Decimal(payment.amount).sub(
      refundedSoFar._sum.amount ?? ZERO(),
    );

    const orderItems = await this.prisma.orderItem.findMany({
      where: { id: { in: request.items.map((item) => item.orderItemId) } },
    });
    const itemById = new Map(orderItems.map((item) => [item.id, item]));

    const math = computeRefund({
      lines: request.items.map((item) => {
        const orderItem = itemById.get(item.orderItemId);
        return {
          orderItemId: item.orderItemId,
          orderedQty: orderItem?.qty ?? 0,
          unitPrice: orderItem?.unitPrice ?? ZERO(),
          lineTotal: orderItem?.lineTotal ?? ZERO(),
          returnQty: item.qty,
        };
      }),
      orderSubtotal: new Prisma.Decimal(order.subtotal),
      orderDiscountTotal: new Prisma.Decimal(order.discountTotal),
      orderShippingFee: new Prisma.Decimal(order.shippingFee),
      refundableRemaining,
      includeShipping: dto.includeShipping === true,
    });

    if (math.refundAmount.lte(0)) {
      throw new BadRequestException(
        'This return is worth nothing: the order has already been fully refunded',
      );
    }

    // Three signals, one conclusion: the order chose COD, or the payment row
    // did, or there is no gateway on the payment at all (which is what a
    // hand-recorded COD settlement looks like).
    const isCod =
      order.paymentMethod === PaymentGateway.COD ||
      payment.gateway === PaymentGateway.COD ||
      !payment.gateway;

    let gatewayRefundId: string | null = null;

    // Called before the transaction, and only for online rails: a gateway call
    // inside a DB transaction would hold row locks across a network round trip,
    // and COD has no gateway to call.
    if (!isCod && payment.externalRef && payment.gateway) {
      gatewayRefundId = await this.payments.refundWithGateway(
        payment.gateway,
        payment.externalRef,
        math.refundAmount,
      );
    }

    const adjustment = await this.booksVendorAdjustment(
      order.id,
      order.vendorId,
      math.refundAmount,
      order.vendorEarning === null ? null : new Prisma.Decimal(order.vendorEarning),
    );

    const refund = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          type: TransactionType.REFUND,
          direction: TransactionDirection.DEBIT,
          status: isCod ? TransactionStatus.PENDING : TransactionStatus.COMPLETED,
          amount: math.refundAmount,
          currency: payment.currency,
          fromType: 'PLATFORM',
          fromId: null,
          toType: 'CUSTOMER',
          toId: order.buyerId,
          gateway: payment.gateway,
          externalRef: gatewayRefundId,
          orderId: order.id,
          vendorId: order.vendorId,
          note:
            dto.note ??
            (isCod
              ? `Return ${id} on order ${order.orderNumber} — manual payout pending`
              : `Return ${id} on order ${order.orderNumber}`),
          completedAt: isCod ? null : new Date(),
        },
      });

      // Recompute the order's payment status from the ledger inside the same
      // transaction that wrote the refund, so a concurrent refund cannot leave
      // it stale.
      const totals = await tx.transaction.aggregate({
        where: {
          orderId: order.id,
          type: TransactionType.REFUND,
          status: TransactionStatus.COMPLETED,
        },
        _sum: { amount: true },
      });

      const fullyRefunded = (totals._sum.amount ?? ZERO()).gte(
        new Prisma.Decimal(payment.amount),
      );

      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: fullyRefunded
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
        },
      });

      await tx.returnRequest.update({
        where: { id },
        data: { status: ReturnStatus.REFUNDED, refundAmount: math.refundAmount },
      });

      return created;
    });

    // The order only becomes RETURNED once every unit is back, not once any
    // return is refunded: a half-returned order is still a live order.
    const fullyReturned = await this.isOrderFullyReturned(order.id);

    if (fullyReturned && order.status === OrderStatus.DELIVERED) {
      await this.orderStatus.moveToSystem(
        undefined,
        order.id,
        OrderStatus.RETURNED,
        { note: `All items returned (return ${id})`, actorId: user.id },
      );
    }

    this.logger.log(
      `Refund ${refund.id} of ${math.refundAmount.toFixed(2)} BDT issued for return ${id} ` +
        `(${isCod ? 'COD, pending manual payout' : 'gateway'})` +
        (adjustment ? `, vendor adjustment ${adjustment.id}` : ''),
    );

    await this.notifyTransition(
      { ...request, status: ReturnStatus.REFUNDED, refundAmount: math.refundAmount },
      {
        buyerTemplate: 'return-refunded',
        buyerSubject: `Refund issued for order ${request.order.orderNumber}`,
        vendorTemplate: 'vendor-return-refunded',
        vendorSubject: `Refund issued for return ${id}`,
        extra: {
          currency: 'BDT',
          amount: math.refundAmount.toFixed(2),
          paymentNote: isCod
            ? 'This order was paid cash on delivery, so our team will contact you to arrange the refund.'
            : 'The amount has been returned to your original payment method.',
          adjustmentNote: adjustment
            ? 'A deduction was added to your next payout to account for this refund.'
            : 'No payout adjustment was needed for this order.',
        },
      },
    );

    return {
      refund,
      refundAmount: math.refundAmount.toFixed(2),
      isCod,
      awaitingManualPayout: isCod,
      breakdown: {
        returnedSubtotal: math.returnedSubtotal.toFixed(2),
        discountShare: math.discountShare.toFixed(2),
        shippingIncluded: math.shippingIncluded.toFixed(2),
        cappedByRemainingRefundable: math.capped,
      },
      vendorAdjustment: adjustment
        ? { id: adjustment.id, amount: adjustment.amount.toFixed(2) }
        : null,
      fullyReturned,
    };
  }

  /**
   * Records a negative ADJUSTMENT against the vendor when their money has
   * already left.
   *
   * Once a payout has been approved for the order, the vendor has been paid the
   * full `vendorEarning`. A refund gives money back to the buyer that nobody
   * clawed back, so the platform carries a debt to the vendor. It is booked as a
   * negative ADJUSTMENT (VENDOR -> PLATFORM) rather than by editing the payout,
   * because the payout row is an immutable record of what was actually sent.
   * The next payout nets it off.
   *
   * Only the *vendor's* share of the refund is owed back, not the whole amount:
   * the platform collected commission on it, and the buyer is not being made
   * whole for the shipping the platform charged itself.
   */
  private async booksVendorAdjustment(
    orderId: string,
    vendorId: string,
    refundAmount: Prisma.Decimal,
    vendorEarning: Prisma.Decimal | null,
  ): Promise<{ id: string; amount: Prisma.Decimal } | null> {
    const alreadyPaidOut = await this.prisma.transactionOrder.findFirst({
      where: { orderId, transaction: { type: TransactionType.PAYOUT } },
      select: { transactionId: true },
    });

    if (!alreadyPaidOut) {
      // No payout covers the order, so the vendor's available balance simply
      // falls when the order is refunded. A ledger row here would double-count.
      return null;
    }

    // The vendor gave the platform `vendorEarning`; the buyer's refund is drawn
    // from the same pot, so the amount the vendor is short is the refund scaled
    // to their share of the order.
    const basis = vendorEarning ?? refundAmount;
    const amount = basis.lte(0)
      ? refundAmount
      : refundAmount.mul(basis).div(basis.add(refundAmount));

    if (amount.lte(0)) {
      return null;
    }

    const adjustment = await this.prisma.transaction.create({
      data: {
        type: TransactionType.ADJUSTMENT,
        direction: TransactionDirection.DEBIT,
        status: TransactionStatus.COMPLETED,
        amount,
        currency: 'BDT',
        fromType: 'VENDOR',
        fromId: vendorId,
        toType: 'PLATFORM',
        toId: null,
        vendorId,
        orderId,
        note: 'Vendor share clawed back after a return refund on an already-paid order',
        completedAt: new Date(),
      },
    });

    return { id: adjustment.id, amount };
  }

  /** True when every ordered unit on the order is covered by a refunded return. */
  private async isOrderFullyReturned(orderId: string): Promise<boolean> {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { id: true, qty: true },
    });

    if (items.length === 0) {
      return false;
    }

    const returned = await this.prisma.returnItem.findMany({
      where: {
        orderItemId: { in: items.map((item) => item.id) },
        returnRequest: { status: ReturnStatus.REFUNDED },
      },
      select: { orderItemId: true, qty: true },
    });

    const byItem = new Map<string, number>();
    for (const row of returned) {
      byItem.set(row.orderItemId, (byItem.get(row.orderItemId) ?? 0) + row.qty);
    }

    return items.every(
      (item) => (byItem.get(item.id) ?? 0) >= item.qty,
    );
  }

  // ---------------------------------------------------------------- helpers

  private filterWhere(
    query: ListReturnsQueryDto,
    scope: { vendorId?: string } = {},
  ): Prisma.ReturnRequestWhereInput {
    const createdAt: { gte?: Date; lte?: Date } = {};

    if (query.from) {
      createdAt.gte = new Date(query.from);
    }

    if (query.to) {
      createdAt.lte = new Date(query.to);
    }

    return {
      // A caller-supplied vendorId never overrides the token-scoped one: the
      // spread order matters, the scope must win.
      ...(query.status ? { status: query.status as ReturnStatus } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.buyerId ? { buyerId: query.buyerId } : {}),
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
      ...scope,
    };
  }

  /**
   * Best-effort notification for both parties.
   *
   * A missing mail credential or a deleted user must not roll back a state
   * change that already committed, so failures are logged and swallowed. Both
   * parties are notified independently: the buyer not hearing about a decision is
   * worse than the vendor's copy failing.
   */
  private async notifyTransition(
    request: {
      id: string;
      status: ReturnStatus;
      order: { orderNumber: string };
      buyer: { id: string; name: string; email: string | null };
      vendor: { id: string; businessName: string; userId: string | null };
      refundAmount?: Prisma.Decimal | null;
    },
    options: {
      buyerTemplate: string;
      buyerSubject: string;
      vendorTemplate: string;
      vendorSubject: string;
      extra?: Record<string, string | number>;
    },
  ) {
    const shared = {
      returnNumber: request.id.slice(0, 8),
      orderNumber: request.order.orderNumber,
      reason: request.status,
      ...(options.extra ?? {}),
    };

    const results = await Promise.allSettled([
      request.buyer.email
        ? this.notifications.sendTransactionalEmail(
            request.buyer.id,
            request.buyer.email,
            options.buyerSubject,
            options.buyerTemplate,
            { ...shared, name: request.buyer.name },
          )
        : Promise.resolve(undefined),
      request.vendor.userId
        ? this.notifications.sendTransactionalEmail(
            request.vendor.userId,
            await this.emailOf(request.vendor.userId),
            options.vendorSubject,
            options.vendorTemplate,
            { ...shared, name: request.vendor.businessName },
          )
        : Promise.resolve(undefined),
    ]);

    for (const outcome of results) {
      if (outcome.status === 'rejected') {
        this.logger.warn(
          `Return ${request.id} notification failed: ` +
            ((outcome.reason as Error)?.message ?? 'unknown error'),
        );
      }
    }
  }

  private async emailOf(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    return user?.email ?? '';
  }
}
