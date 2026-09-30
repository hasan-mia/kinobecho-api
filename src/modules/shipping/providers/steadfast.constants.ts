/**
 * Every Steadfast base URL, endpoint path and header name lives here so the
 * integration can be corrected against the official docs without touching the
 * provider logic. Values are placeholders derived from the documented public
 * contract — verify each against your merchant portal before going live.
 *
 * Docs: https://steadfast.com.bd/api-documentation
 */

export const STEADFAST_DEFAULTS = {
  /** Applied when STEADFAST_BASE_URL is unset. */
  baseUrl: 'https://portal.packzy.com/api/v1',
} as const;

/** Endpoint paths, relative to the configured base URL. */
export const STEADFAST_PATHS = {
  createOrder: '/create_order',
  /** CID is interpolated into the path, so it is built by a helper below. */
  statusByCidPrefix: '/status_by_cid/',
  cancelOrderPrefix: '/cancel_order/',
} as const;

export const STEADFAST_STATUS_BY_CID_PATH = (consignmentId: string): string =>
  `${STEADFAST_PATHS.statusByCidPrefix}${encodeURIComponent(consignmentId)}`;

export const STEADFAST_CANCEL_PATH = (consignmentId: string): string =>
  `${STEADFAST_PATHS.cancelOrderPrefix}${encodeURIComponent(consignmentId)}`;

/** Header names. Steadfast authenticates with two custom headers, not a bearer. */
export const STEADFAST_HEADERS = {
  apiKey: 'Api-Key',
  secretKey: 'Secret-Key',
  contentType: 'Content-Type',
  contentTypeJson: 'application/json',
  /** Inbound webhook: `Authorization: Bearer <STEADFAST_WEBHOOK_TOKEN>`. */
  authorization: 'Authorization',
  authorizationScheme: 'Bearer',
} as const;

/** Inbound webhook path, mounted by the shipping controller. */
export const STEADFAST_WEBHOOK_PATH = '/webhooks/steadfast';

/** Body field names sent to Steadfast (snake_case, unlike our camelCase model). */
export const STEADFAST_FIELDS = {
  invoice: 'invoice',
  recipientName: 'recipient_name',
  recipientPhone: 'recipient_phone',
  recipientAddress: 'recipient_address',
  codAmount: 'cod_amount',
  note: 'note',
} as const;

/** Response paths read back from Steadfast. */
export const STEADFAST_RESPONSE_PATHS = {
  consignment: 'consignment',
  consignmentId: 'consignment_id',
  trackingCode: 'tracking_code',
  deliveryStatus: 'delivery_status',
} as const;

/**
 * Steadfast `delivery_status` -> our ShipmentStatus.
 *
 * Anything absent from this table is treated as unknown: the webhook keeps the
 * current shipment status and logs a warning rather than guessing.
 */
export const STEADFAST_STATUS_MAP: Readonly<Record<string, string>> = {
  pending: 'PENDING',
  in_review: 'PICKED_UP',
  hold: 'PENDING',
  delivered: 'DELIVERED',
  partial_delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
  unknown: 'PENDING',
  delivered_approval_pending: 'DELIVERED',
  cancelled_approval_pending: 'CANCELLED',
  picked_up: 'PICKED_UP',
  in_transit: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  failed: 'FAILED',
  returned: 'RETURNED',
} as const;

/** Webhook `notification_type` values Steadfast sends. */
export const STEADFAST_NOTIFICATION = {
  deliveryStatus: 'delivery_status',
  trackingUpdate: 'tracking_update',
} as const;

/** Inbound webhook field names. */
export const STEADFAST_WEBHOOK_FIELDS = {
  consignmentId: 'consignment_id',
  notificationType: 'notification_type',
  status: 'status',
  trackingMessage: 'tracking_message',
} as const;