import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Order,
  OrderStatus,
  PaymentGateway,
  Prisma,
  TransactionDirection,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { StripeProvider } from './providers/stripe.provider';
import { BkashProvider } from './providers/bkash.provider';
import { NagadProvider } from './providers/nagad.provider';
import { SslCommerzProvider } from './providers/sslcommerz.provider';
import { PaymentGateway as PaymentGatewayContract } from './interfaces/payment-gateway.interface';

export interface ConfirmPaymentInput {
  gateway: PaymentGateway;
  externalRef: string;
  rawResponse: Prisma.InputJsonValue;
  amount?: Prisma.Decimal;
}

export interface RefundOrderInput {
  orderId: string;
  amount?: Prisma.Decimal;
  note?: string;
  gateway?: PaymentGateway;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeProvider,
    private readonly bkash: BkashProvider,
    private readonly nagad: NagadProvider,
    private readonly sslcommerz: SslCommerzProvider,
  ) {}

  private providerFor(gateway: PaymentGateway): PaymentGatewayContract {
    switch (gateway) {
      case PaymentGateway.BKASH:
        return this.bkash;
      case PaymentGateway.NAGAD:
        return this.nagad;
      case PaymentGateway.SSLCOMMERZ:
        return this.sslcommerz;
      case PaymentGateway.STRIPE:
      default:
        return this.stripe;
    }
  }

  async createPaymentForOrder(
    user: AuthenticatedUser,
    orderId: string,
    gateway: PaymentGateway,
  ) {
    const order = await this.requireOrder(orderId);
    this.assertCanManageOrder(user, order);

    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('Cannot pay for a cancelled order');
    }

    const amount = Math.round(Number(order.grandTotal) * 100);
    const provider = this.providerFor(gateway);

    const intent = await provider.createPaymentIntent(amount, 'bdt', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerEmail: user.email ?? '',
      customerName: user.name,
    });

    const transaction = await this.prisma.transaction.upsert({
      where: { externalRef: intent.id },
      update: {
        rawResponse: intent as unknown as Prisma.InputJsonValue,
      },
      create: {
        type: TransactionType.PAYMENT,
        direction: TransactionDirection.CREDIT,
        status: TransactionStatus.PENDING,
        amount: order.grandTotal,
        currency: 'BDT',
        fromType: 'CUSTOMER',
        fromId: order.buyerId,
        toType: 'PLATFORM',
        toId: null,
        gateway,
        externalRef: intent.id,
        rawResponse: intent as unknown as Prisma.InputJsonValue,
        orderId: order.id,
      },
    });

    return { transaction, intent };
  }

  async confirmPayment(input: ConfirmPaymentInput) {
    const existing = await this.prisma.transaction.findUnique({
      where: { externalRef: input.externalRef },
    });

    if (existing && existing.status === TransactionStatus.COMPLETED) {
      this.logger.log(
        `Payment ${input.externalRef} already confirmed, skipping duplicate`,
      );
      return existing;
    }

    const payment =
      existing ??
      (await this.prisma.transaction.findFirst({
        where: { externalRef: input.externalRef },
      }));

    if (!payment) {
      throw new NotFoundException(
        `No payment found for reference ${input.externalRef}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const completed = await tx.transaction.update({
        where: { id: payment.id },
        data: {
          externalRef: input.externalRef,
          status: TransactionStatus.COMPLETED,
          completedAt: new Date(),
          rawResponse: input.rawResponse,
          amount: input.amount ?? payment.amount,
        },
      });

      if (payment.orderId) {
        const order = await tx.order.findUnique({
          where: { id: payment.orderId },
        });

        if (order && order.status === OrderStatus.PENDING) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.CONFIRMED },
          });

          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: order.status,
              toStatus: OrderStatus.CONFIRMED,
              note: `Payment confirmed via ${input.gateway}`,
            },
          });
        }
      }

      return completed;
    });
  }

  async failPayment(gateway: PaymentGateway, externalRef: string, reason: string) {
    const payment = await this.prisma.transaction.findUnique({
      where: { externalRef },
    });

    if (!payment || payment.gateway !== gateway) {
      throw new NotFoundException('Payment not found');
    }

    return this.prisma.transaction.update({
      where: { id: payment.id },
      data: { status: TransactionStatus.FAILED, note: reason },
    });
  }

  async refundOrder(user: AuthenticatedUser, input: RefundOrderInput) {
    const order = await this.requireOrder(input.orderId);

    const isAdmin =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;

    if (!isAdmin) {
      throw new ForbiddenException('Only admins can refund orders');
    }

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

    const amount = input.amount ?? payment.amount;

    if (amount.gt(payment.amount)) {
      throw new BadRequestException('Refund amount exceeds the payment amount');
    }

    if (payment.gateway) {
      const provider = this.providerFor(payment.gateway);

      if (payment.externalRef) {
        await provider.refundPayment(
          payment.externalRef,
          Math.round(Number(amount) * 100),
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const refund = await tx.transaction.create({
        data: {
          type: TransactionType.REFUND,
          direction: TransactionDirection.DEBIT,
          status: TransactionStatus.COMPLETED,
          amount,
          currency: payment.currency,
          fromType: 'PLATFORM',
          fromId: null,
          toType: 'CUSTOMER',
          toId: order.buyerId,
          gateway: input.gateway ?? payment.gateway,
          orderId: order.id,
          note: input.note ?? `Refund for order ${order.orderNumber}`,
          completedAt: new Date(),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: order.status,
          note: `Refund issued: ${amount}`,
          changedById: user.id,
        },
      });

      return refund;
    });
  }

  async getOrderTransactions(
    user: AuthenticatedUser,
    orderId: string,
  ) {
    const order = await this.requireOrder(orderId);
    this.assertCanManageOrder(user, order);

    return this.prisma.transaction.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async requireOrder(orderId: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  private assertCanManageOrder(user: AuthenticatedUser, order: Order) {
    const isAdmin =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;

    if (isAdmin || order.buyerId === user.id) {
      return;
    }

    if (user.vendor && user.vendor.id === order.vendorId) {
      return;
    }

    throw new ForbiddenException('You do not have access to this order');
  }
}
