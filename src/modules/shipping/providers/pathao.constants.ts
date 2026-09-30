/**
 * Every Pathao base URL, endpoint path and header name lives here so the
 * integration can be corrected against the official docs without touching the
 * provider logic.
 *
 * Docs: https://redpathao.gitbook.io/pathao-courier-api
 */

export const PATHAO_DEFAULTS = {
  baseUrl: 'https://courier-api-sandbox.pathao.com',
  productionBaseUrl: 'https://api-hermes.pathao.com',
} as const;

/** API namespace shared by the Aladdin endpoints. */
export const PATHAO_PATHS = {
  issueToken: '/aladdin/api/v1/issue-token',
  orders: '/aladdin/api/v1/orders',
  orderInfoPrefix: '/aladdin/api/v1/order-info/',
  cityList: '/aladdin/api/v1/city-list',
  zoneListPrefix: '/aladdin/api/v1/zone-list/',
} as const;

export const PATHAO_ORDER_INFO_PATH = (consignmentId: string): string =>
  `${PATHAO_PATHS.orderInfoPrefix}${encodeURIComponent(consignmentId)}`;

export const PATHAO_ZONE_LIST_PATH = (cityId: string): string =>
  `${PATHAO_PATHS.zoneListPrefix}${encodeURIComponent(cityId)}`;

export const PATHAO_HEADERS = {
  authorization: 'Authorization',
  authorizationScheme: 'Bearer',
  contentType: 'Content-Type',
  contentTypeJson: 'application/json',
  /** Inbound webhook signature header. */
  signature: 'X-PATHAO-Signature',
  /**
   * Handshake reply header. Pathao compares this against the value configured
   * in the merchant dashboard, which is why it is an env var and not a constant.
   */
  webhookIntegrationSecret: 'X-Pathao-Merchant-Webhook-Integration-Secret',
} as const;

/** Header Pathao reads off the handshake reply. */
export const PATHAO_WEBHOOK_INTEGRATION_SECRET_HEADER =
  PATHAO_HEADERS.webhookIntegrationSecret;

/** Webhook path mounted by the shipping controller. */
export const PATHAO_WEBHOOK_PATH = '/webhooks/pathao';

/** Body field names sent to Pathao (snake_case, like our own schema here). */
export const PATHAO_FIELDS = {
  clientId: 'client_id',
  clientSecret: 'client_secret',
  username: 'username',
  password: 'password',
  grantType: 'grant_type',
  grantTypePassword: 'password',
  grantTypeRefresh: 'refresh_token',
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  expiresIn: 'expires_in',

  storeId: 'store_id',
  merchantOrderId: 'merchant_order_id',
  recipientName: 'recipient_name',
  recipientPhone: 'recipient_phone',
  recipientAddress: 'recipient_address',
  recipientCity: 'recipient_city',
  recipientZone: 'recipient_zone',
  deliveryType: 'delivery_type',
  itemType: 'item_type',
  itemQuantity: 'item_quantity',
  itemWeight: 'item_weight',
  amountToCollect: 'amount_to_collect',
  specialInstruction: 'special_instruction',
} as const;

/** Response paths read back from Pathao. */
export const PATHAO_RESPONSE_PATHS = {
  data: 'data',
  consignmentId: 'consignment_id',
  orderStatus: 'order_status',
  clientId: 'client_id',
  conversation: 'conversation',
} as const;

/**
 * Documented enum values accepted by the order-creation endpoint.
 * delivery_type 48 = Normal, item_type 2 = Parcel.
 */
export const PATHAO_ORDER_ENUMS = {
  deliveryTypeNormal: 48,
  itemTypeParcel: 2,
} as const;

/**
 * Pathao accepts item_weight in KG. The documented bounds are enforced here so
 * an over-weight or tiny parcel is still accepted by the courier.
 */
export const PATHAO_WEIGHT_KG = {
  min: 0.5,
  max: 10,
} as const;

/**
 * Pathao `order_status` -> our ShipmentStatus.
 *
 * An unrecognised value is NOT mapped: the caller keeps the current status and
 * logs a warning, because guessing could mark a parcel delivered early.
 */
export const PATHAO_STATUS_MAP: Readonly<Record<string, string>> = {
  pending: 'PENDING',
  'order.picked': 'PICKED_UP',
  picked_up: 'PICKED_UP',
  'order.in-transit': 'IN_TRANSIT',
  in_transit: 'IN_TRANSIT',
  'order.out-for-delivery': 'OUT_FOR_DELIVERY',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  'order.delivered': 'DELIVERED',
  delivered: 'DELIVERED',
  'order.returned': 'RETURNED',
  returned: 'RETURNED',
  'order.pickup-failed': 'FAILED',
  pickup_failed: 'FAILED',
  'order.delivery-failed': 'FAILED',
  delivery_failed: 'FAILED',
  'order.cancelled': 'CANCELLED',
  cancelled: 'CANCELLED',
} as const;

/** Webhook `event` values Pathao sends. */
export const PATHAO_WEBHOOK_EVENTS = {
  integration: 'webhook_integration',
  picked: 'order.picked',
  inTransit: 'order.in-transit',
  outForDelivery: 'order.out-for-delivery',
  delivered: 'order.delivered',
  returned: 'order.returned',
  pickupFailed: 'order.pickup-failed',
  deliveryFailed: 'order.delivery-failed',
  cancelled: 'order.cancelled',
} as const;

/** Inbound webhook field names. */
export const PATHAO_WEBHOOK_FIELDS = {
  event: 'event',
  consignmentId: 'consignment_id',
  orderStatus: 'order_status',
  clientId: 'client_id',
} as const;

/** Access tokens are cached this many seconds before their stated expiry. */
export const PATHAO_TOKEN_EXPIRY_SAFETY_SECONDS = 60;

/** Redis key prefix for the cached access token. */
export const PATHAO_TOKEN_CACHE_KEY = 'pathao:access_token';

/** City/zone lookups change rarely, so they are cached for a day. */
export const PATHAO_GEO_CACHE_TTL_SECONDS = 60 * 60 * 24;