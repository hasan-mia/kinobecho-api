import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  CourierProvider,
  OrderStatus,
  PaymentGateway,
  Prisma,
  ShipmentStatus,
  UserRole,
  VendorStatus,
} from '@prisma/client';
import { ShippingService } from '../src/modules/shipping/shipping.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';
import { RedisCacheService } from '../src/common/cache/redis-cache.service';
import { CourierFactory } from '../src/modules/shipping/courier.factory';
import { OrderStatusService } from '../src/modules/shipping/order-status.service';
import {
  extractBearer,
  secureCompare,
} from '../src/modules/shipping/shipping-webhook.controller';
import {
  PATHAO_WEBHOOK_INTEGRATION_SECRET_HEADER,
} from '../src/modules/shipping/providers/pathao.constants';

const admin = (
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser => ({
  id: 'admin-1',
  email: 'admin@kinobecho.dev',
  name: 'Admin',
  role: UserRole.ADMIN,
  roleId: null,
  vendor: null,
  ...overrides,
});

const vendorUser = (vendorId: string): AuthenticatedUser =>
  admin({
    id: 'vendor-user-1',
    role: UserRole.VENDOR,
    vendor: {
      id: vendorId,
      slug: 'rahim',
      businessName: 'Rahim',
      status: VendorStatus.ACTIVE,
    },
  });

const buildOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  orderNumber: 'KB-1',
  buyerId: 'buyer-1',
  vendorId: 'vendor-1',
  status: OrderStatus.CONFIRMED,
  grandTotal: new Prisma.Decimal('2500.00'),
  paymentMethod: PaymentGateway.COD,
  shippingAddress: {
    recipientName: 'Buyer',
    phone: '01700000000',
    line1: 'House 5, Road 2',
    line2: null,
    city: 'Dhaka',
    district: 'Dhaka',
    postalCode: '1207',
  },
  items: [
    {
      id: 'item-1',
      qty: 2,
      productNameSnap: 'T-shirt',
      productVariant: { product: { weightGrams: 500 } },
    },
  ],
  ...overrides,
});

describe('ShippingService', () => {
  let prisma: Record<string, any>;
  let factory: { get: ReturnType<typeof vi.fn> };
  let orderStatus: { moveToSystem: ReturnType<typeof vi.fn> };
  let service: ShippingService;
  let provider: {
    createShipment: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    provider = {
      createShipment: vi.fn().mockResolvedValue({
        consignmentId: 'CID-1',
        trackingCode: 'TRK-1',
        raw: { success: true },
      }),
      getStatus: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    factory = { get: vi.fn().mockReturnValue(provider) };
    orderStatus = { moveToSystem: vi.fn().mockResolvedValue({ id: 'order-1' }) };

    prisma = {
      order: { findUnique: vi.fn() },
      shipment: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'shipment-1' }),
        update: vi.fn().mockResolvedValue({ id: 'shipment-1', orderId: 'order-1' }),
      },
      shipmentEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'wh-1' }),
      },
      $transaction: vi.fn(),
    };

    prisma.$transaction.mockImplementation(
      (cb: (tx: unknown) => unknown) => cb(prisma),
    );

    service = new ShippingService(
      prisma as unknown as PrismaService,
      factory as unknown as CourierFactory,
      orderStatus as unknown as OrderStatusService,
      { get: () => undefined } as unknown as ConfigService,
      {} as RedisCacheService,
    );
  });

  describe('COD amount rule', () => {
    it('collects grandTotal for a COD order', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await service.createShipment(admin(), {
        orderId: 'order-1',
        courier: CourierProvider.STEADFAST,
      });

      expect(provider.createShipment).toHaveBeenCalledWith(
        expect.objectContaining({ codAmount: new Prisma.Decimal('2500.00') }),
      );
      expect(prisma.shipment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ codAmount: new Prisma.Decimal('2500.00') }),
        }),
      );
    });

    it('collects zero for a prepaid order', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ paymentMethod: PaymentGateway.STRIPE }),
      );

      await service.createShipment(admin(), {
        orderId: 'order-1',
        courier: CourierProvider.STEADFAST,
      });

      expect(provider.createShipment).toHaveBeenCalledWith(
        expect.objectContaining({ codAmount: new Prisma.Decimal(0) }),
      );
    });

    it('collects zero when no payment method is set yet', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ paymentMethod: null }),
      );

      await service.createShipment(admin(), {
        orderId: 'order-1',
        courier: CourierProvider.PATHAO,
      });

      expect(provider.createShipment).toHaveBeenCalledWith(
        expect.objectContaining({ codAmount: new Prisma.Decimal(0) }),
      );
    });
  });

  describe('one active shipment per order', () => {
    it('rejects a second active shipment before calling the courier', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
      });

      await expect(
        service.createShipment(admin(), {
          orderId: 'order-1',
          courier: CourierProvider.STEADFAST,
        }),
      ).rejects.toThrow('already has an active shipment (IN_TRANSIT)');

      // No money spent on a courier call that would be thrown away.
      expect(provider.createShipment).not.toHaveBeenCalled();
    });

    it('re-checks inside the transaction to close the race window', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());
      // Clear for the pre-check, then present for the in-transaction re-check.
      prisma.shipment.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'shipment-1', status: ShipmentStatus.PENDING });

      await expect(
        service.createShipment(admin(), {
          orderId: 'order-1',
          courier: CourierProvider.STEADFAST,
        }),
      ).rejects.toThrow('already has an active shipment');

      expect(prisma.shipment.create).not.toHaveBeenCalled();
    });

    it('allows a new shipment once the previous one is cancelled', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());
      // CANCELLED is absent from ACTIVE_SHIPMENT_STATUSES, so findFirst misses.
      prisma.shipment.findFirst.mockResolvedValue(null);

      await service.createShipment(admin(), {
        orderId: 'order-1',
        courier: CourierProvider.STEADFAST,
      });

      expect(prisma.shipment.create).toHaveBeenCalled();
    });

    it('treats DELIVERED as not active', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());
      prisma.shipment.findFirst.mockResolvedValue(null);

      await service.createShipment(admin(), {
        orderId: 'order-1',
        courier: CourierProvider.STEADFAST,
      });

      expect(prisma.shipment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            orderId: 'order-1',
            status: { in: expect.arrayContaining([ShipmentStatus.PENDING]) },
          },
        }),
      );
      // DELIVERED/FAILED/RETURNED must not be in the active set.
      const statuses = prisma.shipment.findFirst.mock.calls[0][0].where.status.in;
      expect(statuses).not.toContain(ShipmentStatus.DELIVERED);
      expect(statuses).not.toContain(ShipmentStatus.FAILED);
      expect(statuses).not.toContain(ShipmentStatus.RETURNED);
      expect(statuses).not.toContain(ShipmentStatus.CANCELLED);
    });
  });

  describe('shipment creation guards', () => {
    it('rejects an order that is not CONFIRMED or PROCESSING', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ status: OrderStatus.PENDING }),
      );

      await expect(
        service.createShipment(admin(), {
          orderId: 'order-1',
          courier: CourierProvider.STEADFAST,
        }),
      ).rejects.toThrow('only be created for a confirmed or processing order');
    });

    it('rejects a vendor touching another vendor order', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await expect(
        service.createShipment(vendorUser('other-vendor'), {
          orderId: 'order-1',
          courier: CourierProvider.STEADFAST,
        }),
      ).rejects.toThrow('Only the owning vendor or an admin can do this');
    });

    it('allows the owning vendor', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await service.createShipment(vendorUser('vendor-1'), {
        orderId: 'order-1',
        courier: CourierProvider.STEADFAST,
      });

      expect(prisma.shipment.create).toHaveBeenCalled();
    });

    it('saves nothing when the courier call fails', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());
      provider.createShipment.mockRejectedValue(
        new Error('Steadfast could not create the shipment'),
      );

      await expect(
        service.createShipment(admin(), {
          orderId: 'order-1',
          courier: CourierProvider.STEADFAST,
        }),
      ).rejects.toThrow();

      // A half-written shipment would block every retry.
      expect(prisma.shipment.create).not.toHaveBeenCalled();
      expect(prisma.shipmentEvent.create).not.toHaveBeenCalled();
      expect(orderStatus.moveToSystem).not.toHaveBeenCalled();
    });

    it('moves the order to SHIPPED after the shipment is saved', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await service.createShipment(admin(), {
        orderId: 'order-1',
        courier: CourierProvider.STEADFAST,
      });

      expect(orderStatus.moveToSystem).toHaveBeenCalledWith(
        expect.anything(),
        'order-1',
        OrderStatus.SHIPPED,
        expect.objectContaining({ note: 'Shipment created via STEADFAST' }),
      );
      // A real actor is on the request, so the history row can attribute it.
    });

    it('refuses to route MANUAL through the courier path', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await expect(
        service.createShipment(admin(), {
          orderId: 'order-1',
          courier: CourierProvider.MANUAL,
        }),
      ).rejects.toThrow('POST /shipments/manual');
    });

    it('creates a manual shipment without any courier call', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await service.createManualShipment(admin(), {
        orderId: 'order-1',
        trackingCode: '  TRACK-9  ',
      });

      expect(provider.createShipment).not.toHaveBeenCalled();
      expect(prisma.shipment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          courier: CourierProvider.MANUAL,
          trackingCode: 'TRACK-9',
          consignmentId: null,
        }),
        include: { events: true },
      });
      expect(orderStatus.moveToSystem).toHaveBeenCalledWith(
        expect.anything(),
        'order-1',
        OrderStatus.SHIPPED,
        expect.anything(),
      );
    });

    it('requires a tracking code for a manual shipment', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await expect(
        service.createManualShipment(admin(), {
          orderId: 'order-1',
          trackingCode: '   ',
        }),
      ).rejects.toThrow('A tracking code is required');
    });

    it('refuses to cancel a courier that has no cancel support', async () => {
      prisma.shipment.findUnique.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.PENDING,
        consignmentId: 'CID-1',
        courier: CourierProvider.PATHAO,
        order: { vendorId: 'vendor-1' },
      });
      factory.get.mockReturnValue({ createShipment: vi.fn() });

      await expect(
        service.cancelShipment(admin(), 'shipment-1'),
      ).rejects.toThrow('PATHAO does not support cancellation');
    });

    it('only cancels a pending shipment', async () => {
      prisma.shipment.findUnique.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
        consignmentId: 'CID-1',
        courier: CourierProvider.STEADFAST,
        order: { vendorId: 'vendor-1' },
      });

      await expect(
        service.cancelShipment(admin(), 'shipment-1'),
      ).rejects.toThrow('Only a pending shipment can be cancelled');
    });

    it('calls the courier and records the cancellation', async () => {
      prisma.shipment.findUnique.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.PENDING,
        consignmentId: 'CID-1',
        courier: CourierProvider.STEADFAST,
        order: { vendorId: 'vendor-1' },
      });
      prisma.shipment.findUnique.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.PENDING,
        consignmentId: 'CID-1',
        courier: CourierProvider.STEADFAST,
        order: { vendorId: 'vendor-1' },
      });

      await service.cancelShipment(admin(), 'shipment-1');

      expect(provider.cancel).toHaveBeenCalledWith('CID-1');
      expect(prisma.shipment.update).toHaveBeenCalledWith({
        where: { id: 'shipment-1' },
        data: { status: ShipmentStatus.CANCELLED },
      });
    });
  });

  describe('Steadfast webhook', () => {
    const payload = (extra: Record<string, unknown> = {}) => ({
      consignment_id: 'CID-1',
      notification_type: 'delivery_status',
      status: 'delivered',
      timestamp: '2026-09-30T10:00:00.000Z',
      ...extra,
    });

    it('processes a delivery_status webhook', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
      });

      const result = await service.handleSteadfastWebhook(payload());

      expect(result).toMatchObject({ duplicate: false, handled: true });
      expect(prisma.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ShipmentStatus.DELIVERED },
        }),
      );
      expect(orderStatus.moveToSystem).toHaveBeenCalledWith(
        undefined,
        'order-1',
        OrderStatus.DELIVERED,
        expect.anything(),
      );
    });

    it('records a tracking_update without changing status', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
      });

      const result = await service.handleSteadfastWebhook(
        payload({
          notification_type: 'tracking_update',
          tracking_message: 'Rider reached Mirpur',
        }),
      );

      expect(result.message).toBe('Tracking update recorded');
      expect(prisma.shipment.update).not.toHaveBeenCalled();
      expect(prisma.shipmentEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          note: 'Rider reached Mirpur',
          status: ShipmentStatus.IN_TRANSIT,
        }),
      });
    });

    it('is idempotent: a redelivered webhook is ignored', async () => {
      prisma.webhookEvent.findUnique.mockResolvedValue({ id: 'wh-1' });

      const result = await service.handleSteadfastWebhook(payload());

      expect(result).toMatchObject({ duplicate: true, handled: true });
      expect(prisma.shipment.update).not.toHaveBeenCalled();
      expect(prisma.shipmentEvent.create).not.toHaveBeenCalled();
    });

    it('builds a deterministic eventId per provider/consignment/status/timestamp', async () => {
      await service.handleSteadfastWebhook(payload());
      await service.handleSteadfastWebhook(payload());

      const first = prisma.webhookEvent.create.mock.calls[0]![0].data.eventId;
      const second = prisma.webhookEvent.create.mock.calls[1]![0].data.eventId;

      expect(first).toBe(
        'steadfast:CID-1:delivery_status:2026-09-30T10:00:00.000Z',
      );
      expect(second).toBe(first);
    });

    it('does not let a RETURNED event change the order status', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
      });

      await service.handleSteadfastWebhook(payload({ status: 'cancelled' }));

      expect(prisma.shipment.update).toHaveBeenCalled();
      expect(orderStatus.moveToSystem).not.toHaveBeenCalled();
    });

    it('records an event only for an unmapped status', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
      });

      await service.handleSteadfastWebhook(payload({ status: 'teleported' }));

      expect(prisma.shipment.update).not.toHaveBeenCalled();
      expect(orderStatus.moveToSystem).not.toHaveBeenCalled();
      expect(prisma.shipmentEvent.create).toHaveBeenCalled();
    });

    it('does not re-deliver an order already marked delivered', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.DELIVERED,
      });

      await service.handleSteadfastWebhook(payload({ status: 'in_transit' }));

      expect(prisma.shipment.update).not.toHaveBeenCalled();
      expect(orderStatus.moveToSystem).not.toHaveBeenCalled();
    });

    it('ignores a webhook for an unknown consignment', async () => {
      prisma.shipment.findFirst.mockResolvedValue(null);

      const result = await service.handleSteadfastWebhook(payload());

      expect(result).toMatchObject({ handled: false, message: 'Unknown shipment' });
    });

    it('rejects a webhook with no consignment_id', async () => {
      await expect(
        service.handleSteadfastWebhook({ notification_type: 'delivery_status' }),
      ).rejects.toThrow('no consignment_id');
    });
  });

  describe('Pathao webhook', () => {
    const payload = (extra: Record<string, unknown> = {}) => ({
      consignment_id: 'P-1',
      event: 'order.delivered',
      event_time: '2026-09-30T10:00:00.000Z',
      ...extra,
    });

    it('answers the integration handshake without persisting anything', async () => {
      const result = await service.handlePathaoWebhook({
        event: 'webhook_integration',
      });

      expect(result).toMatchObject({ handled: false, duplicate: false });
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
      expect(prisma.shipmentEvent.create).not.toHaveBeenCalled();
    });

    it('maps order.delivered to DELIVERED and drives the order', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.OUT_FOR_DELIVERY,
      });

      await service.handlePathaoWebhook(payload());

      expect(prisma.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: ShipmentStatus.DELIVERED } }),
      );
      expect(orderStatus.moveToSystem).toHaveBeenCalledWith(
        undefined,
        'order-1',
        OrderStatus.DELIVERED,
        expect.anything(),
      );
    });

    it('maps each documented event', async () => {
      const cases: [string, ShipmentStatus][] = [
        ['order.picked', ShipmentStatus.PICKED_UP],
        ['order.in-transit', ShipmentStatus.IN_TRANSIT],
        ['order.returned', ShipmentStatus.RETURNED],
        ['order.pickup-failed', ShipmentStatus.FAILED],
        ['order.delivery-failed', ShipmentStatus.FAILED],
        ['order.cancelled', ShipmentStatus.CANCELLED],
      ];

      for (const [event, expected] of cases) {
        prisma.shipment.findFirst.mockResolvedValue({
          id: 'shipment-1',
          status: ShipmentStatus.PENDING,
        });

        await service.handlePathaoWebhook(payload({ event }));

        expect(prisma.shipment.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: { status: expected } }),
        );
      }
    });

    it('does not change the order on FAILED or RETURNED', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
      });

      await service.handlePathaoWebhook(payload({ event: 'order.delivery-failed' }));

      expect(prisma.shipment.update).toHaveBeenCalled();
      expect(orderStatus.moveToSystem).not.toHaveBeenCalled();
    });

    it('records an event only for an unknown event name', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
      });

      await service.handlePathaoWebhook(payload({ event: 'order.teleported' }));

      expect(prisma.shipment.update).not.toHaveBeenCalled();
      expect(prisma.shipmentEvent.create).toHaveBeenCalled();
    });

    it('is idempotent on redelivery', async () => {
      prisma.webhookEvent.findUnique.mockResolvedValue({ id: 'wh-1' });

      const result = await service.handlePathaoWebhook(payload());

      expect(result.duplicate).toBe(true);
      expect(prisma.shipment.update).not.toHaveBeenCalled();
    });

    it('namespaces the eventId by provider', async () => {
      await service.handlePathaoWebhook(payload());
      await service.handlePathaoWebhook(payload());

      const first = prisma.webhookEvent.create.mock.calls[0]![0].data.eventId;
      const second = prisma.webhookEvent.create.mock.calls[1]![0].data.eventId;

      expect(first).toBe('pathao:P-1:order.delivered:2026-09-30T10:00:00.000Z');
      expect(second).toBe(first);
    });
  });
});

describe('webhook auth helpers', () => {
  it('compares equal secrets', () => {
    expect(secureCompare('token-abc', 'token-abc')).toBe(true);
  });

  it('rejects a different secret', () => {
    expect(secureCompare('token-abc', 'token-xyz')).toBe(false);
  });

  it('rejects secrets of different lengths without throwing', () => {
    expect(secureCompare('short', 'much-longer-secret')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(secureCompare(undefined, 'token')).toBe(false);
    expect(secureCompare('token', undefined)).toBe(false);
    expect(secureCompare(undefined, undefined)).toBe(false);
  });

  it('extracts a bearer token', () => {
    expect(extractBearer('Bearer tok-1')).toBe('tok-1');
    expect(extractBearer('bearer tok-1')).toBe('tok-1');
  });

  it('accepts a bare token', () => {
    expect(extractBearer('tok-1')).toBe('tok-1');
  });

  it('returns undefined for an empty or missing header', () => {
    expect(extractBearer('')).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer('Bearer ')).toBeUndefined();
  });

  it('exposes the documented Pathao integration header name', () => {
    expect(PATHAO_WEBHOOK_INTEGRATION_SECRET_HEADER).toBe(
      'X-Pathao-Merchant-Webhook-Integration-Secret',
    );
  });
});