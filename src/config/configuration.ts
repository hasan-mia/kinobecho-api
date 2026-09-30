import { registerAs } from '@nestjs/config';

/**
 * CORS_ORIGIN is a comma-separated list. Splitting without trimming leaves a
 * leading space on every entry but the first, which never matches the `Origin`
 * request header, so trimming is mandatory rather than cosmetic.
 */
export const splitCorsOrigins = (value: string | undefined | null): string[] =>
  (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  apiVersion: process.env.API_VERSION ?? '1',
  publicUrl: process.env.PUBLIC_URL,
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  swaggerEnabled: process.env.SWAGGER_ENABLED === 'true',
}));

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  provider: process.env.DATABASE_PROVIDER ?? 'postgresql',
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD ?? undefined,
  db: parseInt(process.env.REDIS_DB ?? '0', 10),
}));

export const jwtConfig = registerAs('jwt', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET,
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
}));

export const stripeConfig = registerAs('stripe', () => ({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
}));

// Cash on delivery. COD_ENABLED is the master switch exposed by
// GET /payments/methods; COD_MAX_AMOUNT caps the order total that may be paid
// on delivery, so vendors cannot be asked to collect an unbounded amount.
export const codConfig = registerAs('cod', () => ({
  enabled: process.env.COD_ENABLED !== 'false',
  maxAmount: Number(process.env.COD_MAX_AMOUNT ?? 20000),
}));

// Order lifecycle. paymentTtlMinutes is how long a freshly placed order stays
// payable before the expiry sweep cancels it and returns the reserved stock.
// COD orders are exempt: their expiresAt is cleared when COD is selected.
export const orderConfig = registerAs('order', () => ({
  paymentTtlMinutes: Number(process.env.ORDER_PAYMENT_TTL_MINUTES ?? 30),
}));

export const localPaymentsConfig = registerAs('localPayments', () => ({
  bkash: {
    appKey: process.env.BKASH_APP_KEY,
    appSecret: process.env.BKASH_APP_SECRET,
    username: process.env.BKASH_USERNAME,
    password: process.env.BKASH_PASSWORD,
    webhookSecret: process.env.BKASH_WEBHOOK_SECRET,
  },
  nagad: {
    merchantId: process.env.NAGAD_MERCHANT_ID,
    apiKey: process.env.NAGAD_API_KEY,
    apiSecret: process.env.NAGAD_API_SECRET,
    webhookSecret: process.env.NAGAD_WEBHOOK_SECRET,
  },
  sslcommerz: {
    storeId: process.env.SSLCOMMERZ_STORE_ID,
    storePassword: process.env.SSLCOMMERZ_STORE_PASSWORD,
    apiKey: process.env.SSLCOMMERZ_API_KEY,
    apiSecret: process.env.SSLCOMMERZ_API_SECRET,
    sandbox: process.env.SSLCOMMERZ_SANDBOX !== 'false',
  },
}));

// Courier integration endpoints and credentials. Base URLs live here only; the
// per-provider path constants live next to each provider so both halves can be
// corrected against the official docs independently.
export const shippingConfig = registerAs('shipping', () => ({
  defaultZoneName: process.env.SHIPPING_DEFAULT_ZONE_NAME ?? 'DEFAULT',
  steadfast: {
    baseUrl:
      process.env.STEADFAST_BASE_URL ?? 'https://portal.packzy.com/api/v1',
    apiKey: process.env.STEADFAST_API_KEY,
    secretKey: process.env.STEADFAST_SECRET_KEY,
    webhookToken: process.env.STEADFAST_WEBHOOK_TOKEN,
  },
  pathao: {
    baseUrl: process.env.PATHAO_BASE_URL ?? 'https://courier-api-sandbox.pathao.com',
    clientId: process.env.PATHAO_CLIENT_ID,
    clientSecret: process.env.PATHAO_CLIENT_SECRET,
    username: process.env.PATHAO_USERNAME,
    password: process.env.PATHAO_PASSWORD,
    storeId: process.env.PATHAO_STORE_ID,
    webhookSecret: process.env.PATHAO_WEBHOOK_SECRET,
    webhookIntegrationSecret: process.env.PATHAO_WEBHOOK_INTEGRATION_SECRET,
  },
}));

export const storageConfig = registerAs('storage', () => ({
  driver: process.env.STORAGE_DRIVER ?? 'local',
  localUploadPath: process.env.LOCAL_UPLOAD_PATH ?? 'uploads',
  localAssetUrl: process.env.LOCAL_ASSET_URL ?? '/uploads',
  // When set, every public URL is built as CDN_BASE_URL + key. Unset means the
  // provider's own URL scheme is used (local /uploads, S3 or GCS host).
  cdnBaseUrl: process.env.CDN_BASE_URL || null,
  image: {
    maxBytes: Number(process.env.IMAGE_MAX_BYTES ?? 5 * 1024 * 1024),
    maxDimension: Number(process.env.IMAGE_MAX_DIMENSION ?? 6000),
    quality: Number(process.env.IMAGE_WEBP_QUALITY ?? 80),
  },
  s3: {
    bucket: process.env.AWS_S3_BUCKET,
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
  },
  gcs: {
    projectId: process.env.GCP_PROJECT_ID,
    bucket: process.env.GCP_BUCKET,
    credentialsBase64: process.env.GCP_CREDENTIALS_BASE64,
  },
}));

export const mailConfig = registerAs('mail', () => ({
  driver: process.env.MAIL_DRIVER ?? 'smtp',
  from: process.env.MAIL_FROM ?? 'no-reply@kinobecho.com',
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    secure: process.env.SMTP_SECURE === 'true',
  },
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY,
  },
  fcm: {
    projectId: process.env.FCM_PROJECT_ID,
    serviceAccountBase64: process.env.FCM_SERVICE_ACCOUNT_BASE64,
  },
}));

// Outbound SMS. `driver` picks the implementation bound to SMS_PROVIDER:
// `twilio` for Twilio, `http` for a local Bangladeshi gateway whose request
// shape is described by `http.template`.
export const smsConfig = registerAs('sms', () => ({
  driver: process.env.SMS_DRIVER ?? 'http',
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_SMS_FROM,
  },
  http: {
    url: process.env.SMS_HTTP_URL,
    apiKey: process.env.SMS_HTTP_API_KEY,
    senderId: process.env.SMS_HTTP_SENDER_ID,
    // Placeholders substituted by the HTTP provider; see SMS_HTTP_TEMPLATE.
    template: process.env.SMS_HTTP_TEMPLATE,
  },
}));

// One-time passcodes. The rate limit is deliberately separate from the Nest
// throttler: that one is per-IP, this one is per-phone, so a single attacker
// cannot exhaust one victim's SMS quota from many addresses.
export const otpConfig = registerAs('otp', () => ({
  ttlSeconds: parseInt(process.env.OTP_TTL_SECONDS ?? '300', 10),
  maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS ?? '5', 10),
  requestLimit: parseInt(process.env.OTP_REQUEST_LIMIT ?? '3', 10),
  requestWindowSeconds: parseInt(process.env.OTP_REQUEST_WINDOW_SECONDS ?? '600', 10),
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttl: parseInt(process.env.THROTTLE_TTL ?? '60000', 10),
  limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  authTtl: parseInt(process.env.THROTTLE_AUTH_TTL ?? '900000', 10),
  authLimit: parseInt(process.env.THROTTLE_AUTH_LIMIT ?? '5', 10),
}));

export const logConfig = registerAs('log', () => ({
  level: process.env.LOG_LEVEL ?? 'info',
  pretty: process.env.LOG_PRETTY === 'true',
}));