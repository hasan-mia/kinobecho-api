import {
  BadGatewayException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShipmentStatus } from '@prisma/client';
import axios from 'axios';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';
import {
  CourierProvider,
  CourierStatusResult,
  CreateShipmentInput,
  CreateShipmentResult,
  PathaoCity,
  PathaoZone,
} from '../interfaces/courier-provider.interface';
import {
  PATHAO_DEFAULTS,
  PATHAO_FIELDS,
  PATHAO_GEO_CACHE_TTL_SECONDS,
  PATHAO_HEADERS,
  PATHAO_ORDER_ENUMS,
  PATHAO_ORDER_INFO_PATH,
  PATHAO_PATHS,
  PATHAO_RESPONSE_PATHS,
  PATHAO_STATUS_MAP,
  PATHAO_TOKEN_CACHE_KEY,
  PATHAO_TOKEN_EXPIRY_SAFETY_SECONDS,
  PATHAO_WEIGHT_KG,
  PATHAO_ZONE_LIST_PATH,
} from './pathao.constants';

interface CachedToken {
  accessToken: string;
  refreshToken?: string;
}

@Injectable()
export class PathaoProvider implements CourierProvider {
  private readonly logger = new Logger(PathaoProvider.name);
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly username: string;
  private readonly password: string;
  private readonly storeId: string;

  /** In-process mirror of the Redis token, avoids a cache hit per request. */
  private cachedToken: CachedToken | null = null;
  /** Set when a call returned 401, so the retry re-issues exactly once. */
  private tokenRetried = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly cache: RedisCacheService,
  ) {
    this.baseUrl = (
      this.configService.get<string>('shipping.pathao.baseUrl') ??
      this.configService.get<string>('PATHAO_BASE_URL') ??
      PATHAO_DEFAULTS.baseUrl
    ).replace(/\/$/, '');

    this.clientId = this.read('clientId', 'PATHAO_CLIENT_ID');
    this.clientSecret = this.read('clientSecret', 'PATHAO_CLIENT_SECRET');
    this.username = this.read('username', 'PATHAO_USERNAME');
    this.password = this.read('password', 'PATHAO_PASSWORD');
    this.storeId = this.read('storeId', 'PATHAO_STORE_ID');
  }

  private read(key: string, envKey: string): string {
    return (
      this.configService.get<string>(`shipping.pathao.${key}`) ??
      this.configService.get<string>(envKey) ??
      ''
    );
  }

  /**
   * Returns a usable access token, preferring the refresh flow when Pathao has
   * issued one. Cached in memory and Redis until shortly before expiry.
   */
  private async ensureToken(force = false): Promise<string> {
    if (!force && this.cachedToken?.accessToken) {
      return this.cachedToken.accessToken;
    }

    if (!force) {
      const fromRedis = await this.cache
        .get<CachedToken>(PATHAO_TOKEN_CACHE_KEY)
        .catch(() => undefined);

      if (fromRedis?.accessToken) {
        this.cachedToken = fromRedis;
        return fromRedis.accessToken;
      }
    }

    const body = this.cachedToken?.refreshToken
      ? {
          [PATHAO_FIELDS.clientId]: this.clientId,
          [PATHAO_FIELDS.clientSecret]: this.clientSecret,
          [PATHAO_FIELDS.refreshToken]: this.cachedToken.refreshToken,
          [PATHAO_FIELDS.grantType]: PATHAO_FIELDS.grantTypeRefresh,
        }
      : {
          [PATHAO_FIELDS.clientId]: this.clientId,
          [PATHAO_FIELDS.clientSecret]: this.clientSecret,
          [PATHAO_FIELDS.username]: this.username,
          [PATHAO_FIELDS.password]: this.password,
          [PATHAO_FIELDS.grantType]: PATHAO_FIELDS.grantTypePassword,
        };

    try {
      const { data } = await axios.post(
        `${this.baseUrl}${PATHAO_PATHS.issueToken}`,
        body,
        { headers: { [PATHAO_HEADERS.contentType]: PATHAO_HEADERS.contentTypeJson } },
      );

      const accessToken = data?.[PATHAO_RESPONSE_PATHS.data]
        ?.[PATHAO_FIELDS.accessToken];
      const refreshToken = data?.[PATHAO_RESPONSE_PATHS.data]
        ?.[PATHAO_FIELDS.refreshToken];
      const expiresIn = Number(
        data?.[PATHAO_RESPONSE_PATHS.data]?.[PATHAO_FIELDS.expiresIn] ?? 0,
      );

      if (!accessToken) {
        throw new Error('Pathao issue-token returned no access_token');
      }

      const token: CachedToken = { accessToken, refreshToken };

      this.cachedToken = token;
      this.tokenRetried = false;

      // Cache with a safety margin; fall back to 5 minutes when expires_in is absent.
      const ttl = Math.max(
        expiresIn - PATHAO_TOKEN_EXPIRY_SAFETY_SECONDS,
        300,
      );
      await this.cache
        .set(PATHAO_TOKEN_CACHE_KEY, token, ttl)
        .catch(() => undefined);

      return accessToken;
    } catch (error) {
      // Never log the request body: it carries credentials.
      this.logger.error(
        `Pathao issue-token failed: ${(error as Error).message}`,
      );
      throw new BadGatewayException('Pathao authentication failed.');
    }
  }

  /**
   * Performs an authorised call, re-issuing the token exactly once on a 401.
   * The auth header value is never logged.
   */
  private async request<T>(
    method: 'get' | 'post',
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.ensureToken();

    const send = async (accessToken: string): Promise<T> => {
      const config = {
        headers: {
          [PATHAO_HEADERS.contentType]: PATHAO_HEADERS.contentTypeJson,
          [PATHAO_HEADERS.authorization]: `${PATHAO_HEADERS.authorizationScheme} ${accessToken}`,
        },
      };

      return method === 'post'
        ? (await axios.post(path, payload, config)).data
        : (await axios.get(path, config)).data;
    };

    try {
      return await send(token);
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;

      if (status === 401 && !this.tokenRetried) {
        this.tokenRetried = true;
        this.cachedToken = null;
        await this.cache.del(PATHAO_TOKEN_CACHE_KEY).catch(() => undefined);

        const refreshed = await this.ensureToken(true);

        try {
          return await send(refreshed);
        } catch (retryError) {
          this.logger.error(
            `Pathao ${method} ${path} failed after re-auth: ${(retryError as Error).message}`,
          );
          throw new BadGatewayException(
            'Pathao request failed. Please try again.',
          );
        }
      }

      this.logger.error(`Pathao ${method} ${path} failed: ${(error as Error).message}`);
      throw new BadGatewayException('Pathao request failed. Please try again.');
    }
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const payload: Record<string, unknown> = {
      [PATHAO_FIELDS.storeId]: this.storeId,
      [PATHAO_FIELDS.merchantOrderId]: input.order.orderNumber,
      [PATHAO_FIELDS.recipientName]: input.address.recipientName,
      [PATHAO_FIELDS.recipientPhone]: input.address.phone,
      [PATHAO_FIELDS.recipientAddress]: input.address.address,
      [PATHAO_FIELDS.deliveryType]: PATHAO_ORDER_ENUMS.deliveryTypeNormal,
      [PATHAO_FIELDS.itemType]: PATHAO_ORDER_ENUMS.itemTypeParcel,
      [PATHAO_FIELDS.itemQuantity]: input.itemQuantity ?? 1,
      [PATHAO_FIELDS.itemWeight]: this.toKg(input.weightGrams),
      // Pathao expects whole BDT; prepaid orders send 0.
      [PATHAO_FIELDS.amountToCollect]: Math.round(Number(input.codAmount)),
      [PATHAO_FIELDS.specialInstruction]: input.itemDescription,
    };

    // Only send city/zone when actually known — Pathao resolves them otherwise.
    if (input.recipientCityId) {
      payload[PATHAO_FIELDS.recipientCity] = input.recipientCityId;
    }
    if (input.recipientZoneId) {
      payload[PATHAO_FIELDS.recipientZone] = input.recipientZoneId;
    }

    const data = await this.request<Record<string, unknown>>(
      'post',
      `${this.baseUrl}${PATHAO_PATHS.orders}`,
      payload,
    );

    const responseData = (data?.[PATHAO_RESPONSE_PATHS.data] ??
      {}) as Record<string, unknown>;

    const consignmentId = responseData[PATHAO_RESPONSE_PATHS.consignmentId];

    if (!consignmentId) {
      this.logger.error('Pathao order creation returned no consignment_id');
      throw new BadGatewayException(
        'Pathao could not create the shipment. Please try again.',
      );
    }

    // Pathao has no separate tracking code, so the consignment id doubles as one.
    return {
      consignmentId: String(consignmentId),
      trackingCode: String(consignmentId),
      raw: data,
    };
  }

  async getStatus(consignmentId: string): Promise<CourierStatusResult> {
    const data = await this.request<Record<string, unknown>>(
      'get',
      `${this.baseUrl}${PATHAO_ORDER_INFO_PATH(consignmentId)}`,
    );

    const responseData = (data?.[PATHAO_RESPONSE_PATHS.data] ??
      {}) as Record<string, unknown>;

    const orderStatus = responseData[PATHAO_RESPONSE_PATHS.orderStatus];

    return { status: this.mapStatus(orderStatus), raw: data };
  }

  /** Pathao has no cancel endpoint, so `cancel` is intentionally absent. */
  async listCities(): Promise<PathaoCity[]> {
    const cached = await this.cache
      .get<PathaoCity[]>('pathao:cities')
      .catch(() => undefined);

    if (cached) {
      return cached;
    }

    const data = await this.request<Record<string, unknown>>(
      'get',
      `${this.baseUrl}${PATHAO_PATHS.cityList}`,
    );

    const cities = data?.[PATHAO_RESPONSE_PATHS.data];

    if (!Array.isArray(cities)) {
      throw new BadGatewayException('Pathao returned no city list.');
    }

    await this.cache
      .set('pathao:cities', cities, PATHAO_GEO_CACHE_TTL_SECONDS)
      .catch(() => undefined);

    return cities as PathaoCity[];
  }

  async listZones(cityId: string): Promise<PathaoZone[]> {
    const key = `pathao:zones:${cityId}`;

    const cached = await this.cache.get<PathaoZone[]>(key).catch(() => undefined);
    if (cached) {
      return cached;
    }

    const data = await this.request<Record<string, unknown>>(
      'get',
      `${this.baseUrl}${PATHAO_ZONE_LIST_PATH(cityId)}`,
    );

    const zones = data?.[PATHAO_RESPONSE_PATHS.data];

    if (!Array.isArray(zones)) {
      throw new BadGatewayException('Pathao returned no zone list.');
    }

    await this.cache
      .set(key, zones, PATHAO_GEO_CACHE_TTL_SECONDS)
      .catch(() => undefined);

    return zones as PathaoZone[];
  }

  /** Grams -> KG, clamped to the range Pathao accepts. */
  private toKg(weightGrams: number): number {
    const kg = weightGrams / 1000;
    return Math.min(Math.max(kg, PATHAO_WEIGHT_KG.min), PATHAO_WEIGHT_KG.max);
  }

  /**
   * Maps a Pathao `order_status` through the single table in
   * pathao.constants.ts. Unrecognised values fall back to PENDING and are
   * logged; the caller keeps the current shipment status for event-only updates.
   */
  private mapStatus(orderStatus: unknown): ShipmentStatus {
    if (typeof orderStatus !== 'string') {
      this.logger.warn(
        `Pathao returned a non-string order_status (${typeof orderStatus})`,
      );
      return ShipmentStatus.PENDING;
    }

    const mapped = PATHAO_STATUS_MAP[orderStatus.toLowerCase()];

    if (!mapped) {
      this.logger.warn(
        `Unmapped Pathao order_status "${orderStatus}", keeping current status`,
      );
      return ShipmentStatus.PENDING;
    }

    return mapped as ShipmentStatus;
  }
}