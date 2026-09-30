import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Order, OrderItem, OrderStatus, PaymentGateway, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { OrderSplitterService } from './order-splitter.service';
import { OrderStatusService } from '../shipping/order-status.service';
import {
  CheckoutDto,
  ListAdminOrdersQueryDto,
  ListOrdersQueryDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';

/**
 * Status transition rules now live in OrderStatusService (shared with the
 * shipping webhooks), re-exported here so existing imports keep working.
 */
export { ALLOWED_TRANSITIONS } from '../shipping/order-status.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly splitter: OrderSplitterService,
    private readonly orderStatus: OrderStatusService,
  ) {}

  async checkout(user: AuthenticatedUser, dto: CheckoutDto) {
    const orders = await this.splitter.splitCartIntoOrders(user.id, dto);

    return {
      orderGroupId: orders[0]?.orderGroupId ?? null,
      orders,
    };
  }

  async findMyOrders(user: AuthenticatedUser, query: ListOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.OrderWhereInput = {
      buyerId: user.id,
      orderGroupId: query.orderGroupId,
      status: query.status,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: this.orderInclude(),
      }),
      this.prisma.order.count({ where }),
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

  async findVendorOrders(user: AuthenticatedUser, query: ListOrdersQueryDto) {
    if (!user.vendor) {
      throw new ForbiddenException('Only vendors can access vendor orders');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.OrderWhereInput = {
      vendorId: user.vendor.id,
      orderGroupId: query.orderGroupId,
      status: query.status,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: this.orderInclude(),
      }),
      this.prisma.order.count({ where }),
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

  async findOne(user: AuthenticatedUser, id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        ...this.orderInclude(),
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    await this.assertCanView(user, order);

    return order;
  }

  async updateStatus(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateOrderStatusDto,
  ) {
    return this.orderStatus.moveTo(user, id, dto.status, { note: dto.note });
  }

  /**
   * Platform-wide order list for administrators. Unlike findMyOrders and
   * findVendorOrders this spans every buyer and vendor, and supports filtering
   * by date range, sale channel and free-text order number.
   */
  async findAllOrders(query: ListAdminOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.OrderWhereInput = {
      status: query.status,
      saleChannel: query.saleChannel,
      vendorId: query.vendorId,
      buyerId: query.buyerId,
      orderGroupId: query.orderGroupId,
      orderNumber: query.search
        ? { contains: query.search, mode: 'insensitive' }
        : undefined,
      createdAt:
        query.from || query.to
          ? {
              gte: query.from ? new Date(query.from) : undefined,
              lte: query.to ? new Date(query.to) : undefined,
            }
          : undefined,
    };

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: this.orderInclude(),
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items: orders.map((order) => this.serializeOrder(order)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /** Money is Decimal in the database but must reach the client as a string. */
  private serializeOrder(
    order: Order & {
      items: OrderItem[];
      vendor: { id: string; businessName: string; slug: string; logoUrl: string | null };
      buyer: { id: string; name: string; email: string | null; phone: string | null };
    },
  ) {
    return {
      ...order,
      subtotal: order.subtotal.toFixed(2),
      discountTotal: order.discountTotal.toFixed(2),
      shippingFee: order.shippingFee.toFixed(2),
      grandTotal: order.grandTotal.toFixed(2),
      items: order.items.map((item) => ({
        ...item,
        unitPrice: item.unitPrice.toFixed(2),
        lineTotal: item.lineTotal.toFixed(2),
      })),
    };
  }

  private async assertCanView(user: AuthenticatedUser, order: Order) {
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

  private orderInclude() {
    return {
      items: true,
      vendor: {
        select: { id: true, businessName: true, slug: true, logoUrl: true },
      },
      buyer: {
        select: { id: true, name: true, email: true, phone: true },
      },
    } satisfies Prisma.OrderInclude;
  }
}
