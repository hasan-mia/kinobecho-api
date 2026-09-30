import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CourierProvider,
  OrderStatus,
  PaymentGateway,
  Prisma,
  ShipmentStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { CourierFactory } from './courier.factory';
import {
  CreateShipmentInput,
  PathaoCity,
  PathaoZone,
} from './interfaces/courier-provider.interface';
import { OrderStatusService } from './order-status.service';
import {
  PATHAO_HEADERS,
  PATHAO_STATUS_MAP,
  PATHAO_WEBHOOK_EVENTS,
  PATHAO_WEBHOOK_FIELDS,
} from './providers/pathao.constants';
import {
  STEADFAST_HEADERS,
  STEADFAST_NOTIFICATION,
  STEADFAST_STATUS_MAP,
  STEADFAST_WEBHOOK_FIELDS,
} from './providers/steadfast.constants';

export interface CreateShipmentBody {
  orderId: string;
  courier: CourierProvider;
}

export interface ManualShipmentBody {
  orderId: string;
  trackingCode: string;
}

export interface UpdateShipmentStatusBody {
  status: ShipmentStatus;
  note?: string;
}

export interface WebhookResult {
  duplicate: boolean;
  handled: boolean;
  message: string;
}

/** Statuses that still count as "the order has an active shipment". */
const ACTIVE_SHIPMENT_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.PENDING,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
];

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: CourierFactory,
    private readonly orderStatus: OrderStatusService,
    private readonly configService: ConfigService,
    private readonly cache: RedisCacheService,
  ) {}

  // -------------------------------------------------------------------------
  // Shipment creation
  // -------------------------------------------------------------------------

  /**
   * Creates a shipment with a real courier.
   *
   * If the courier call fails nothing is written and the caller gets a 502 — a
   * half-created shipment would block every retry with the one-active-shipment
   * rule.
   */
  async createShipment(user: AuthenticatedUser, body: CreateShipmentBody) {
    const order = await this.prisma.order.findUnique({
      where: { id: body.orderId },
      include: {
        items: {
          include: {
            productVariant: { select: { product: { select: { weightGrams: true } } } },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    this.assertVendorOrAdmin(user, order);

    if (
      order.status !== OrderStatus.CONFIRMED &&
      order.status !== OrderStatus.PROCESSING
    ) {
      throw new BadRequestException(
        'A shipment can only be created for a confirmed or processing order',
      );
    }

    if (body.courier === CourierProvider.MANUAL) {
      throw new BadRequestException(
        'Use POST /shipments/manual to create a manual shipment with a tracking code',
      );
    }

    await this.assertNoActiveShipment(order.id);

    const codAmount = this.codAmountFor(order);

    const weightGrams = order.items.reduce(
      (sum: number, item) =>
        sum + (item.productVariant?.product.weightGrams ?? 500) * item.qty,
      0,
    );

    const address = this.addressFromOrder(order.shippingAddress);

    const input: CreateShipmentInput = {
      order: { id: order.id, orderNumber: order.orderNumber },
      address,
      codAmount,
      itemDescription: this.itemDescription(order),
      itemQuantity: order.items.length,
      weightGrams,
    };

    // Outside the transaction on purpose: an HTTP call must not hold a DB
    // transaction open. The one-active-shipment invariant is re-checked inside.
    const provider = this.factory.get(body.courier);
    const created = await provider.createShipment(input);

    const shipment = await this.prisma.$transaction(async (tx) => {
      await this.assertNoActiveShipment(order.id, tx);

      const row = await tx.shipment.create({
        data: {
          orderId: order.id,
          courier: body.courier,
          consignmentId: created.consignmentId,
          trackingCode: created.trackingCode,
          status: ShipmentStatus.PENDING,
          codAmount,
          rawResponse: created.raw as Prisma.InputJsonValue,
          events: {
            create: {
              status: ShipmentStatus.PENDING,
              note: `Shipment created via ${body.courier}`,
              occurredAt: new Date(),
              rawPayload: created.raw as Prisma.InputJsonValue,
            },
          },
        },
        include: { events: true },
      });

      return row;
    });

    await this.orderStatus.moveToSystem(user, order.id, OrderStatus.SHIPPED, {
      note: `Shipment created via ${body.courier}`,
    });

    return shipment;
  }

  /** Vendor-driven courier: no outbound API call, tracking code supplied. */
  async createManualShipment(user: AuthenticatedUser, body: ManualShipmentBody) {
    const order = await this.prisma.order.findUnique({ where: { id: body.orderId } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    this.assertVendorOrAdmin(user, order);

    if (
      order.status !== OrderStatus.CONFIRMED &&
      order.status !== OrderStatus.PROCESSING
    ) {
      throw new BadRequestException(
        'A shipment can only be created for a confirmed or processing order',
      );
    }

    if (!body.trackingCode?.trim()) {
      throw new BadRequestException('A tracking code is required');
    }

    await this.assertNoActiveShipment(order.id);

    const codAmount = this.codAmountFor(order);

    const shipment = await this.prisma.$transaction(async (tx) => {
      await this.assertNoActiveShipment(order.id, tx);

      return tx.shipment.create({
        data: {
          orderId: order.id,
          courier: CourierProvider.MANUAL,
          trackingCode: body.trackingCode.trim(),
          consignmentId: null,
          status: ShipmentStatus.PENDING,
          codAmount,
          events: {
            create: {
              status: ShipmentStatus.PENDING,
              note: 'Manual shipment created',
              occurredAt: new Date(),
            },
          },
        },
        include: { events: true },
      });
    });

    await this.orderStatus.moveToSystem(user, order.id, OrderStatus.SHIPPED, {
      note: 'Manual shipment created',
    });

    return shipment;
  }

  /** Ensures at most one non-CANCELLED shipment per order. */
  private async assertNoActiveShipment(
    orderId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;

    const existing = await client.shipment.findFirst({
      where: {
        orderId,
        status: { in: ACTIVE_SHIPMENT_STATUSES },
      },
      select: { id: true, status: true },
    });

    if (existing) {
      throw new BadRequestException(
        `This order already has an active shipment (${existing.status})`,
      );
    }
  }

  /** COD orders collect grandTotal; prepaid orders collect nothing. */
  private codAmountFor(order: { grandTotal: Prisma.Decimal; paymentMethod: PaymentGateway | null }): Prisma.Decimal {
    return order.paymentMethod === PaymentGateway.COD
      ? order.grandTotal
      : new Prisma.Decimal(0);
  }

  private addressFromOrder(shippingAddress: Prisma.JsonValue) {
    const address = (shippingAddress ?? {}) as Record<string, unknown>;

    const line = [address.line1, address.line2, address.city, address.postalCode]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(', ');

    return {
      recipientName: String(address.recipientName ?? ''),
      phone: String(address.phone ?? ''),
      address: line,
      city: typeof address.city === 'string' ? address.city : null,
      district: typeof address.district === 'string' ? address.district : null,
    };
  }

  private itemDescription(order: {
    items: { productNameSnap: string; qty: number }[];
  }): string {
    return order.items
      .map((item) => `${item.productNameSnap} x${item.qty}`)
      .join(', ');
  }

  // -------------------------------------------------------------------------
  // Reads and updates
  // -------------------------------------------------------------------------

  async findByOrder(user: AuthenticatedUser, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    this.assertBuyerVendorOrAdmin(user, order);

    const shipment = await this.prisma.shipment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      include: { events: { orderBy: { occurredAt: 'asc' } } },
    });

    if (!shipment) {
      throw new NotFoundException('No shipment found for this order');
    }

    return shipment;
  }

  async cancelShipment(user: AuthenticatedUser, shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { order: true },
    });

    if (!shipment) {
      throw new NotFoundException('Shipment not found');
    }

    this.assertVendorOrAdmin(user, shipment.order);

    if (shipment.status !== ShipmentStatus.PENDING) {
      throw new BadRequestException(
        'Only a pending shipment can be cancelled',
      );
    }

    const provider = this.factory.get(shipment.courier);

    if (!provider.cancel) {
      throw new BadRequestException(
        `${shipment.courier} does not support cancellation`,
      );
    }

    if (shipment.consignmentId) {
      await provider.cancel(shipment.consignmentId);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.CANCELLED },
      });

      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: ShipmentStatus.CANCELLED,
          note: 'Shipment cancelled',
          occurredAt: new Date(),
        },
      });

      return tx.shipment.findUnique({
        where: { id: shipment.id },
        include: { events: { orderBy: { occurredAt: 'asc' } } },
      });
    });
  }

  /** MANUAL courier status updates, and a manual override for others. */
  async updateStatus(
    user: AuthenticatedUser,
    shipmentId: string,
    body: UpdateShipmentStatusBody,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { order: true },
    });

    if (!shipment) {
      throw new NotFoundException('Shipment not found');
    }

    this.assertVendorOrAdmin(user, shipment.order);

    return this.applyStatus(shipment.id, body.status, {
      note: body.note,
      payload: undefined,
      actorId: user.id,
    });
  }

  /**
   * Applies a shipment status and records the event. DELIVERED additionally
   * drives the order to DELIVERED so COD settlement runs; RETURNED/FAILED only
   * record state and never change the order.
   */
  private async applyStatus(
    shipmentId: string,
    status: ShipmentStatus,
    options: {
      note?: string;
      payload?: Prisma.InputJsonValue;
      actorId?: string;
      system?: boolean;
    },
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.shipment.update({
        where: { id: shipmentId },
        data: { status },
        include: { order: true },
      });

      await tx.shipmentEvent.create({
        data: {
          shipmentId,
          status,
          note: options.note,
          occurredAt: new Date(),
          rawPayload: options.payload,
        },
      });

      return updated;
    });

    if (status === ShipmentStatus.DELIVERED) {
      await this.orderStatus.moveToSystem(undefined, result.orderId, OrderStatus.DELIVERED, {
        note: 'Shipment delivered',
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Records a webhook event idempotently. Returns the created row when this is
   * the first delivery, or null when the event was already processed.
   */
  private async claimWebhookEvent(
    eventId: string,
    provider: string,
    type: string,
    payload: Prisma.InputJsonValue,
  ): Promise<boolean> {
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { eventId },
      select: { id: true },
    });

    if (existing) {
      return false;
    }

    try {
      await this.prisma.webhookEvent.create({
        data: { eventId, provider, type, payload },
      });
      return true;
    } catch (error) {
      // A concurrent delivery won the race; treat it as a duplicate.
      this.logger.warn(
        `Webhook event ${eventId} claimed concurrently, treating as duplicate`,
      );
      return false;
    }
  }

  /** Deterministic id so a redelivered webhook never double-processes. */
  private buildEventId(
    provider: string,
    consignmentId: string,
    status: string,
    timestamp: unknown,
  ): string {
    const stamp =
      timestamp instanceof Date
        ? timestamp.toISOString()
        : String(timestamp ?? 'na');
    return `${provider}:${consignmentId}:${status}:${stamp}`;
  }

  async handleSteadfastWebhook(payload: Record<string, unknown>): Promise<WebhookResult> {
    const consignmentId = String(
      payload[STEADFAST_WEBHOOK_FIELDS.consignmentId] ?? '',
    );

    if (!consignmentId) {
      throw new BadRequestException('Steadfast webhook has no consignment_id');
    }

    const notificationType = String(
      payload[STEADFAST_WEBHOOK_FIELDS.notificationType] ?? '',
    );
    const status = String(payload[STEADFAST_WEBHOOK_FIELDS.status] ?? '');
    const occurredAt = this.parseTimestamp(payload);

    const eventId = this.buildEventId(
      'steadfast',
      consignmentId,
      notificationType || status,
      occurredAt.toISOString(),
    );

    const claimed = await this.claimWebhookEvent(
      eventId,
      'steadfast',
      notificationType,
      payload as Prisma.InputJsonValue,
    );

    if (!claimed) {
      return { duplicate: true, handled: true, message: 'Duplicate event ignored' };
    }

    const shipment = await this.prisma.shipment.findFirst({
      where: { courier: CourierProvider.STEADFAST, consignmentId },
    });

    if (!shipment) {
      this.logger.warn(
        `Steadfast webhook for unknown consignment ${consignmentId}`,
      );
      return { duplicate: false, handled: false, message: 'Unknown shipment' };
    }

    if (notificationType === STEADFAST_NOTIFICATION.trackingUpdate) {
      // A tracking scan is informational: event only, status untouched.
      await this.prisma.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: shipment.status,
          note: String(payload[STEADFAST_WEBHOOK_FIELDS.trackingMessage] ?? ''),
          occurredAt,
          rawPayload: payload as Prisma.InputJsonValue,
        },
      });

      return { duplicate: false, handled: true, message: 'Tracking update recorded' };
    }

    const mapped = STEADFAST_STATUS_MAP[status.toLowerCase()];

    if (!mapped) {
      this.logger.warn(
        `Unmapped Steadfast webhook status "${status}", recording event only`,
      );

      await this.prisma.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: shipment.status,
          note: `Unmapped status: ${status}`,
          occurredAt,
          rawPayload: payload as Prisma.InputJsonValue,
        },
      });

      return {
        duplicate: false,
        handled: true,
        message: 'Unmapped status recorded',
      };
    }

    const nextStatus = mapped as ShipmentStatus;
    const wasDelivered = shipment.status === ShipmentStatus.DELIVERED;

    if (!wasDelivered) {
      await this.applyStatus(shipment.id, nextStatus, {
        payload: payload as Prisma.InputJsonValue,
        system: true,
      });
    } else {
      await this.prisma.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: shipment.status,
          note: `Late update: ${status}`,
          occurredAt,
          rawPayload: payload as Prisma.InputJsonValue,
        },
      });
    }

    return { duplicate: false, handled: true, message: `Shipment ${nextStatus}` };
  }

  async handlePathaoWebhook(payload: Record<string, unknown>): Promise<WebhookResult> {
    if (
      payload[PATHAO_WEBHOOK_FIELDS.event] === PATHAO_WEBHOOK_EVENTS.integration
    ) {
      // Handshake: Pathao verifies this reply, nothing to persist.
      return { duplicate: false, handled: false, message: 'Integration verified' };
    }

    const consignmentId = String(
      payload[PATHAO_WEBHOOK_FIELDS.consignmentId] ?? '',
    );

    if (!consignmentId) {
      throw new BadRequestException('Pathao webhook has no consignment_id');
    }

    const event = String(payload[PATHAO_WEBHOOK_FIELDS.event] ?? '');
    const occurredAt = this.parseTimestamp(payload);

    const eventId = this.buildEventId(
      'pathao',
      consignmentId,
      event,
      occurredAt.toISOString(),
    );

    const claimed = await this.claimWebhookEvent(
      eventId,
      'pathao',
      event,
      payload as Prisma.InputJsonValue,
    );

    if (!claimed) {
      return { duplicate: true, handled: true, message: 'Duplicate event ignored' };
    }

    const shipment = await this.prisma.shipment.findFirst({
      where: { courier: CourierProvider.PATHAO, consignmentId },
    });

    if (!shipment) {
      this.logger.warn(`Pathao webhook for unknown consignment ${consignmentId}`);
      return { duplicate: false, handled: false, message: 'Unknown shipment' };
    }

    // Pathao sends both `event` and `order_status`; prefer the richer value.
    const statusKey = String(
      payload[PATHAO_WEBHOOK_FIELDS.orderStatus] || event,
    );

    const mapped = PATHAO_STATUS_MAP[statusKey.toLowerCase()];

    if (!mapped) {
      this.logger.warn(
        `Unmapped Pathao event "${event}", recording event only`,
      );

      await this.prisma.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: shipment.status,
          note: `Unmapped event: ${event}`,
          occurredAt,
          rawPayload: payload as Prisma.InputJsonValue,
        },
      });

      return { duplicate: false, handled: true, message: 'Unmapped event recorded' };
    }

    const nextStatus = mapped as ShipmentStatus;

    if (shipment.status === ShipmentStatus.DELIVERED) {
      await this.prisma.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: shipment.status,
          note: `Late update: ${event}`,
          occurredAt,
          rawPayload: payload as Prisma.InputJsonValue,
        },
      });
    } else {
      await this.applyStatus(shipment.id, nextStatus, {
        payload: payload as Prisma.InputJsonValue,
        system: true,
      });
    }

    return { duplicate: false, handled: true, message: `Shipment ${nextStatus}` };
  }

  private parseTimestamp(payload: Record<string, unknown>): Date {
    for (const key of ['timestamp', 'event_time', 'occurred_at']) {
      const value = payload[key];
      if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }
    }
    return new Date();
  }

  // -------------------------------------------------------------------------
  // Pathao admin helpers
  // -------------------------------------------------------------------------

  async listPathaoCities(): Promise<PathaoCity[]> {
    const provider = this.factory.get(CourierProvider.PATHAO);

    if (!provider.listCities) {
      throw new BadRequestException('Courier does not support city lookups');
    }

    return provider.listCities();
  }

  async listPathaoZones(cityId: string): Promise<PathaoZone[]> {
    const provider = this.factory.get(CourierProvider.PATHAO);

    if (!provider.listZones) {
      throw new BadRequestException('Courier does not support zone lookups');
    }

    return provider.listZones(cityId);
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  private assertVendorOrAdmin(
    user: AuthenticatedUser,
    order: { vendorId: string },
  ) {
    const isAdmin =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;

    if (isAdmin) {
      return;
    }

    if (user.vendor && user.vendor.id === order.vendorId) {
      return;
    }

    throw new ForbiddenException('Only the owning vendor or an admin can do this');
  }

  private assertBuyerVendorOrAdmin(
    user: AuthenticatedUser,
    order: { buyerId: string; vendorId: string },
  ) {
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

  /** Header names re-exported for the controller; compared secrets stay here. */
  static readonly headers = {
    pathaoSignature: PATHAO_HEADERS.signature,
    pathaoIntegrationSecret: PATHAO_HEADERS.webhookIntegrationSecret,
    steadfastAuthorization: STEADFAST_HEADERS.authorization,
  };
}