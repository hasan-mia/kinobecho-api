import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  Prisma,
  TransactionDirection,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import {
  ListPayoutsQueryDto,
  RejectPayoutDto,
} from './dto/payout.dto';

const PAYOUT_TRANSACTION_INCLUDE = {
  vendor: { select: { id: true, businessName: true, slug: true } },
  settledOrders: {
    include: {
      order: { select: { id: true, orderNumber: true, grandTotal: true } },
    },
  },
} satisfies Prisma.TransactionInclude;

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async requestPayout(user: AuthenticatedUser, orderIds: string[]) {
    if (!user.vendor) {
      throw new ForbiddenException('Only vendors can request payouts');
    }

    if (!orderIds.length) {
      throw new BadRequestException('orderIds must not be empty');
    }

    const vendor = await this.prisma.vendor.findUnique({
      where: { id: user.vendor.id },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    const orders = await this.prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, orderNumber: true, vendorId: true, grandTotal: true, status: true },
    });

    if (orders.length !== new Set(orderIds).size) {
      throw new NotFoundException('One or more orders were not found');
    }

    const foreign = orders.filter((order) => order.vendorId !== vendor.id);

    if (foreign.length > 0) {
      throw new ForbiddenException(
        'All orders must belong to the requesting vendor',
      );
    }

    const notDelivered = orders.filter(
      (order) => order.status !== OrderStatus.DELIVERED,
    );

    if (notDelivered.length > 0) {
      throw new BadRequestException(
        'Only DELIVERED orders can be settled: ' +
          notDelivered.map((order) => order.orderNumber).join(', '),
      );
    }

    const alreadySettled = await this.prisma.transactionOrder.findMany({
      where: {
        orderId: { in: orders.map((order) => order.id) },
        transaction: { type: TransactionType.PAYOUT },
      },
      select: { orderId: true },
    });

    if (alreadySettled.length > 0) {
      throw new BadRequestException(
        'Some of these orders are already covered by a payout',
      );
    }

    const commissionFactor = new Prisma.Decimal(1).minus(
      new Prisma.Decimal(vendor.commissionRate).div(100),
    );

    const amount = orders.reduce(
      (sum, order) => sum.add(new Prisma.Decimal(order.grandTotal).mul(commissionFactor)),
      new Prisma.Decimal(0),
    );

    const payout = await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: {
          type: TransactionType.PAYOUT,
          direction: TransactionDirection.DEBIT,
          status: TransactionStatus.PENDING,
          amount,
          currency: 'BDT',
          fromType: 'PLATFORM',
          fromId: null,
          toType: 'VENDOR',
          toId: vendor.id,
          payoutMethod: vendor.payoutMethod,
          vendorId: vendor.id,
          note: `Settlement for ${orders.length} order(s)`,
          settledOrders: {
            create: orders.map((order) => ({ orderId: order.id })),
          },
        },
        include: PAYOUT_TRANSACTION_INCLUDE,
      });

      return transaction;
    });

    this.logger.log(
      `Payout ${payout.id} created for vendor ${vendor.id} (${amount} BDT)`,
    );

    return payout;
  }

  async findVendorPayouts(
    user: AuthenticatedUser,
    query: ListPayoutsQueryDto,
  ) {
    if (!user.vendor) {
      throw new ForbiddenException('Only vendors can list payouts');
    }

    return this.listPayouts(
      { vendorId: user.vendor.id, status: query.status },
      query.page,
      query.limit,
    );
  }

  async findAllPayouts(query: ListPayoutsQueryDto) {
    return this.listPayouts(
      { vendorId: query.vendorId, status: query.status },
      query.page,
      query.limit,
    );
  }

  async approve(transactionId: string) {
    const payout = await this.requirePayout(transactionId);

    if (payout.status !== TransactionStatus.PENDING) {
      throw new BadRequestException(
        `Payout is already ${payout.status.toLowerCase()}`,
      );
    }

    return this.prisma.transaction.update({
      where: { id: payout.id },
      data: { status: TransactionStatus.COMPLETED, completedAt: new Date() },
      include: PAYOUT_TRANSACTION_INCLUDE,
    });
  }

  async reject(transactionId: string, note: string) {
    const payout = await this.requirePayout(transactionId);

    if (payout.status !== TransactionStatus.PENDING) {
      throw new BadRequestException(
        `Payout is already ${payout.status.toLowerCase()}`,
      );
    }

    return this.prisma.transaction.update({
      where: { id: payout.id },
      data: {
        status: TransactionStatus.FAILED,
        note: `${payout.note ?? ''} | Rejected: ${note}`.trim(),
      },
      include: PAYOUT_TRANSACTION_INCLUDE,
    });
  }

  private async requirePayout(transactionId: string) {
    const payout = await this.prisma.transaction.findFirst({
      where: { id: transactionId, type: TransactionType.PAYOUT },
    });

    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    return payout;
  }

  private async listPayouts(
    where: { vendorId?: string; status?: TransactionStatus },
    page = 1,
    limit = 20,
  ) {
    const whereClause: Prisma.TransactionWhereInput = {
      type: TransactionType.PAYOUT,
      ...where,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where: whereClause,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: PAYOUT_TRANSACTION_INCLUDE,
      }),
      this.prisma.transaction.count({ where: whereClause }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
