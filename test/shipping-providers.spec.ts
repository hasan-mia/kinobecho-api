import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ShipmentStatus } from '@prisma/client';
import axios from 'axios';
import { SteadfastProvider } from '../src/modules/shipping/providers/steadfast.provider';
import { PathaoProvider } from '../src/modules/shipping/providers/pathao.provider';
import { STEADFAST_STATUS_MAP } from '../src/modules/shipping/providers/steadfast.constants';
import { PATHAO_STATUS_MAP } from '../src/modules/shipping/providers/pathao.constants';
import { RedisCacheService } from '../src/common/cache/redis-cache.service';

const configFor = (values: Record<string, string>) =>
  ({
    get: (key: string) => values[key],
  }) as unknown as ConfigService;

describe('Steadfast status mapping', () => {
  it('maps every documented delivery_status through the single table', () => {
    expect(STEADFAST_STATUS_MAP.pending).toBe(ShipmentStatus.PENDING);
    expect(STEADFAST_STATUS_MAP.in_review).toBe(ShipmentStatus.PICKED_UP);
    expect(STEADFAST_STATUS_MAP.hold).toBe(ShipmentStatus.PENDING);
    expect(STEADFAST_STATUS_MAP.delivered).toBe(ShipmentStatus.DELIVERED);
    expect(STEADFAST_STATUS_MAP.partial_delivered).toBe(ShipmentStatus.DELIVERED);
    expect(STEADFAST_STATUS_MAP.cancelled).toBe(ShipmentStatus.CANCELLED);
    expect(STEADFAST_STATUS_MAP.delivered_approval_pending).toBe(
      ShipmentStatus.DELIVERED,
    );
    expect(STEADFAST_STATUS_MAP.cancelled_approval_pending).toBe(
      ShipmentStatus.CANCELLED,
    );
  });

  it('leaves unknown values unmapped so the caller keeps the current status', () => {
    expect(STEADFAST_STATUS_MAP.teleported).toBeUndefined();
  });
});

describe('SteadfastProvider', () => {
  let provider: SteadfastProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new SteadfastProvider(
      configFor({
        'shipping.steadfast.baseUrl': 'https://example.test/api/v1',
        'shipping.steadfast.apiKey': 'key-1',
        'shipping.steadfast.secretKey': 'secret-1',
      }),
    );
  });

  it('reads consignment_id and tracking_code from the response', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        success: true,
        consignment: { consignment_id: 'CID-1', tracking_code: 'TRK-1' },
      },
    });

    const result = await provider.createShipment({
      order: { id: 'order-1', orderNumber: 'KB-1' },
      address: { recipientName: 'Buyer', phone: '01700000000', address: 'Dhaka' },
      codAmount: new (await import('@prisma/client')).Prisma.Decimal('1500'),
      itemDescription: 'T-shirt x2',
      weightGrams: 1000,
    });

    expect(result.consignmentId).toBe('CID-1');
    expect(result.trackingCode).toBe('TRK-1');
    expect(result.raw).toEqual({
      success: true,
      consignment: { consignment_id: 'CID-1', tracking_code: 'TRK-1' },
    });
  });

  it('sends invoice, recipient fields and a numeric cod_amount', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { consignment: { consignment_id: 'C', tracking_code: 'T' } },
    });

    const { Prisma } = await import('@prisma/client');

    await provider.createShipment({
      order: { id: 'order-1', orderNumber: 'KB-20260930-ABC' },
      address: { recipientName: 'Buyer', phone: '01700000000', address: 'Dhaka' },
      codAmount: new Prisma.Decimal('2500.75'),
      itemDescription: 'T-shirt x2',
      weightGrams: 1000,
    });

    const [, body, config] = post.mock.calls[0]!;
    expect(body).toMatchObject({
      invoice: 'KB-20260930-ABC',
      recipient_name: 'Buyer',
      recipient_phone: '01700000000',
      recipient_address: 'Dhaka',
      cod_amount: 2500.75,
    });
    expect(config!.headers).toMatchObject({
      'Api-Key': 'key-1',
      'Secret-Key': 'secret-1',
      'Content-Type': 'application/json',
    });
  });

  it('sends cod_amount 0 for prepaid orders', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { consignment: { consignment_id: 'C', tracking_code: 'T' } },
    });

    const { Prisma } = await import('@prisma/client');

    await provider.createShipment({
      order: { id: 'order-1', orderNumber: 'KB-1' },
      address: { recipientName: 'Buyer', phone: '017', address: 'Dhaka' },
      codAmount: new Prisma.Decimal(0),
      itemDescription: 'x',
      weightGrams: 500,
    });

    expect((post.mock.calls[0]![1] as Record<string, unknown>).cod_amount).toBe(0);
  });

  it('throws 502 when the courier returns no consignment id', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: false } });

    const { Prisma } = await import('@prisma/client');

    await expect(
      provider.createShipment({
        order: { id: 'o', orderNumber: 'KB-1' },
        address: { recipientName: 'B', phone: '1', address: 'D' },
        codAmount: new Prisma.Decimal(0),
        itemDescription: 'x',
        weightGrams: 500,
      }),
    ).rejects.toThrow('Steadfast could not create the shipment');
  });

  it('maps a known delivery_status on getStatus', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { delivery_status: 'delivered' },
    });

    const result = await provider.getStatus('CID-1');

    expect(result.status).toBe(ShipmentStatus.DELIVERED);
  });

  it('falls back to PENDING for an unknown delivery_status', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { delivery_status: 'teleported' },
    });

    const result = await provider.getStatus('CID-1');

    expect(result.status).toBe(ShipmentStatus.PENDING);
  });

  it('calls the status_by_cid endpoint with the cid in the path', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { delivery_status: 'pending' },
    });

    await provider.getStatus('CID-9');

    expect(get.mock.calls[0]![0]).toBe(
      'https://example.test/api/v1/status_by_cid/CID-9',
    );
  });
});

describe('Pathao status mapping', () => {
  it('maps the documented order events', () => {
    expect(PATHAO_STATUS_MAP['order.picked']).toBe(ShipmentStatus.PICKED_UP);
    expect(PATHAO_STATUS_MAP['order.in-transit']).toBe(ShipmentStatus.IN_TRANSIT);
    expect(PATHAO_STATUS_MAP['order.delivered']).toBe(ShipmentStatus.DELIVERED);
    expect(PATHAO_STATUS_MAP['order.returned']).toBe(ShipmentStatus.RETURNED);
    expect(PATHAO_STATUS_MAP['order.pickup-failed']).toBe(ShipmentStatus.FAILED);
    expect(PATHAO_STATUS_MAP['order.delivery-failed']).toBe(ShipmentStatus.FAILED);
    expect(PATHAO_STATUS_MAP['order.cancelled']).toBe(ShipmentStatus.CANCELLED);
  });

  it('leaves unknown statuses unmapped', () => {
    expect(PATHAO_STATUS_MAP['order.teleported']).toBeUndefined();
  });
});

describe('PathaoProvider', () => {
  let provider: PathaoProvider;
  let cache: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };

  const build = () => {
    cache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    };

    return new PathaoProvider(
      configFor({
        'shipping.pathao.baseUrl': 'https://pathao.test',
        'shipping.pathao.clientId': 'client-1',
        'shipping.pathao.clientSecret': 'client-secret',
        'shipping.pathao.username': 'user',
        'shipping.pathao.password': 'pass',
        'shipping.pathao.storeId': 'store-1',
      }),
      cache as unknown as RedisCacheService,
    );
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = build();
  });

  it('issues a token with the password grant and caches it', async () => {
    const post = vi.spyOn(axios, 'post').mockImplementation(
      async (url: string) => {
        if (String(url).includes('issue-token')) {
          return { data: { data: { access_token: 'tok-1', expires_in: 28800 } } };
        }
        return { data: { data: { consignment_id: 'P-1' } } };
      },
    );

    const { Prisma } = await import('@prisma/client');

    const result = await provider.createShipment({
      order: { id: 'o', orderNumber: 'KB-1' },
      address: { recipientName: 'B', phone: '017', address: 'Dhaka' },
      codAmount: new Prisma.Decimal('1500'),
      itemDescription: 'x',
      weightGrams: 1200,
    });

    expect(result.consignmentId).toBe('P-1');
    // No separate tracking field, so the consignment id doubles as the code.
    expect(result.trackingCode).toBe('P-1');

    const tokenCall = post.mock.calls.find((c) =>
      String(c[0]).includes('issue-token'),
    )!;
    expect(tokenCall[1]).toMatchObject({
      client_id: 'client-1',
      client_secret: 'client-secret',
      username: 'user',
      password: 'pass',
      grant_type: 'password',
    });
    expect(cache.set).toHaveBeenCalledWith(
      'pathao:access_token',
      { accessToken: 'tok-1', refreshToken: undefined },
      expect.any(Number),
    );
  });

  it('converts grams to KG and clamps to the minimum of 0.5', async () => {
    const post = vi.spyOn(axios, 'post').mockImplementation(
      async (url: string) => {
        if (String(url).includes('issue-token')) {
          return { data: { data: { access_token: 'tok-1', expires_in: 3600 } } };
        }
        return { data: { data: { consignment_id: 'P-1' } } };
      },
    );

    const { Prisma } = await import('@prisma/client');

    await provider.createShipment({
      order: { id: 'o', orderNumber: 'KB-1' },
      address: { recipientName: 'B', phone: '017', address: 'Dhaka' },
      codAmount: new Prisma.Decimal(0),
      itemDescription: 'x',
      weightGrams: 100,
    });

    const orderCall = post.mock.calls.find((c) => String(c[0]).endsWith('/orders'))!;
    expect((orderCall[1] as Record<string, unknown>).item_weight).toBe(0.5);
  });

  it('sends delivery_type 48, item_type 2 and an integer collect amount', async () => {
    const post = vi.spyOn(axios, 'post').mockImplementation(
      async (url: string) => {
        if (String(url).includes('issue-token')) {
          return { data: { data: { access_token: 'tok-1', expires_in: 3600 } } };
        }
        return { data: { data: { consignment_id: 'P-1' } } };
      },
    );

    const { Prisma } = await import('@prisma/client');

    await provider.createShipment({
      order: { id: 'o', orderNumber: 'KB-1' },
      address: { recipientName: 'B', phone: '017', address: 'Dhaka' },
      codAmount: new Prisma.Decimal('1500.99'),
      itemDescription: 'x',
      weightGrams: 2000,
      itemQuantity: 3,
    });

    const orderCall = post.mock.calls.find((c) => String(c[0]).endsWith('/orders'))!;
    expect(orderCall[1]).toMatchObject({
      store_id: 'store-1',
      merchant_order_id: 'KB-1',
      delivery_type: 48,
      item_type: 2,
      item_quantity: 3,
      item_weight: 2,
      // Fractional BDT is truncated; couriers collect whole taka.
      amount_to_collect: 1501,
    });
  });

  it('omits recipient_city and recipient_zone when unknown', async () => {
    const post = vi.spyOn(axios, 'post').mockImplementation(
      async (url: string) => {
        if (String(url).includes('issue-token')) {
          return { data: { data: { access_token: 'tok-1', expires_in: 3600 } } };
        }
        return { data: { data: { consignment_id: 'P-1' } } };
      },
    );

    const { Prisma } = await import('@prisma/client');

    await provider.createShipment({
      order: { id: 'o', orderNumber: 'KB-1' },
      address: { recipientName: 'B', phone: '017', address: 'Dhaka' },
      codAmount: new Prisma.Decimal(0),
      itemDescription: 'x',
      weightGrams: 500,
    });

    const orderCall = post.mock.calls.find((c) => String(c[0]).endsWith('/orders'))!;
    const body = orderCall[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('recipient_city');
    expect(body).not.toHaveProperty('recipient_zone');
  });

  it('sends recipient_city and recipient_zone when supplied', async () => {
    const post = vi.spyOn(axios, 'post').mockImplementation(
      async (url: string) => {
        if (String(url).includes('issue-token')) {
          return { data: { data: { access_token: 'tok-1', expires_in: 3600 } } };
        }
        return { data: { data: { consignment_id: 'P-1' } } };
      },
    );

    const { Prisma } = await import('@prisma/client');

    await provider.createShipment({
      order: { id: 'o', orderNumber: 'KB-1' },
      address: { recipientName: 'B', phone: '017', address: 'Dhaka' },
      codAmount: new Prisma.Decimal(0),
      itemDescription: 'x',
      weightGrams: 500,
      recipientCityId: 'city-1',
      recipientZoneId: 'zone-2',
    });

    const orderCall = post.mock.calls.find((c) => String(c[0]).endsWith('/orders'))!;
    expect(orderCall[1]).toMatchObject({
      recipient_city: 'city-1',
      recipient_zone: 'zone-2',
    });
  });

  it('re-issues the token exactly once after a 401', async () => {
    let tokenCalls = 0;
    let orderCalls = 0;

    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (String(url).includes('issue-token')) {
        tokenCalls += 1;
        return {
          data: {
            data: {
              access_token: `tok-${tokenCalls}`,
              expires_in: 3600,
            },
          },
        };
      }

      orderCalls += 1;
      // First authorised attempt fails, the retry succeeds.
      if (orderCalls === 1) {
        throw Object.assign(new Error('unauthorized'), {
          response: { status: 401 },
        });
      }

      return { data: { data: { consignment_id: 'P-1' } } };
    });

    const { Prisma } = await import('@prisma/client');

    const result = await provider.createShipment({
      order: { id: 'o', orderNumber: 'KB-1' },
      address: { recipientName: 'B', phone: '017', address: 'Dhaka' },
      codAmount: new Prisma.Decimal(0),
      itemDescription: 'x',
      weightGrams: 500,
    });

    expect(result.consignmentId).toBe('P-1');
    // Token issued twice: initial + one forced re-issue.
    expect(tokenCalls).toBe(2);
    // Order attempted twice: the original and the single retry.
    expect(orderCalls).toBe(2);
    expect(cache.del).toHaveBeenCalledWith('pathao:access_token');
  });

  it('does not retry more than once on repeated 401s', async () => {
    let orderCalls = 0;

    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (String(url).includes('issue-token')) {
        return { data: { data: { access_token: 'tok-1', expires_in: 3600 } } };
      }

      orderCalls += 1;
      throw Object.assign(new Error('unauthorized'), {
        response: { status: 401 },
      });
    });

    const { Prisma } = await import('@prisma/client');

    await expect(
      provider.createShipment({
        order: { id: 'o', orderNumber: 'KB-1' },
        address: { recipientName: 'B', phone: '017', address: 'Dhaka' },
        codAmount: new Prisma.Decimal(0),
        itemDescription: 'x',
        weightGrams: 500,
      }),
    ).rejects.toThrow('Pathao request failed');

    expect(orderCalls).toBe(2);
  });

  it('maps a known order_status on getStatus', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: { data: { access_token: 'tok-1', expires_in: 3600 } },
    });
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { data: { order_status: 'order.delivered' } },
    });

    const result = await provider.getStatus('P-1');

    expect(result.status).toBe(ShipmentStatus.DELIVERED);
  });

  it('falls back to PENDING for an unknown order_status', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: { data: { access_token: 'tok-1', expires_in: 3600 } },
    });
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { data: { order_status: 'order.teleported' } },
    });

    const result = await provider.getStatus('P-1');

    expect(result.status).toBe(ShipmentStatus.PENDING);
  });

  it('does not implement cancel', () => {
    expect(
      (provider as unknown as { cancel?: unknown }).cancel,
    ).toBeUndefined();
  });
});