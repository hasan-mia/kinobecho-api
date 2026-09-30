import * as Joi from 'joi';
import { splitCorsOrigins } from './configuration';

/**
 * CORS_ORIGIN is a comma-separated list of origins, so `Joi.string().uri()`
 * cannot validate it directly (it rejects the commas). Every entry is trimmed
 * and validated as a URI individually.
 */
const corsOrigins = () =>
  Joi.string()
    .required()
    .custom((value: string, helpers) => {
      const origins = splitCorsOrigins(value);

      if (origins.length === 0) {
        return helpers.message({
          custom: 'CORS_ORIGIN must list at least one origin URI',
        });
      }

      const invalid = origins.filter((o) => Joi.string().uri().validate(o).error);
      if (invalid.length > 0) {
        return helpers.message({
          custom: `CORS_ORIGIN contains an invalid origin URI: ${invalid.join(', ')}`,
        });
      }

      return value;
    });

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api'),
  API_VERSION: Joi.string().default('1'),
  PUBLIC_URL: Joi.string().uri().optional(),
  CORS_ORIGIN: corsOrigins(),
  SWAGGER_ENABLED: Joi.boolean().default(false),

  DATABASE_URL: Joi.string().required(),
  DATABASE_PROVIDER: Joi.string()
    .valid('postgresql', 'mysql', 'mongodb')
    .default('postgresql'),

  REDIS_HOST: Joi.string().hostname().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_DB: Joi.number().integer().min(0).max(15).default(0),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  STRIPE_SECRET_KEY: Joi.string().required(),
  STRIPE_WEBHOOK_SECRET: Joi.string().required(),
  STRIPE_PUBLISHABLE_KEY: Joi.string().required(),

  BKASH_APP_KEY: Joi.string().allow('').optional(),
  BKASH_APP_SECRET: Joi.string().allow('').optional(),
  BKASH_USERNAME: Joi.string().allow('').optional(),
  BKASH_PASSWORD: Joi.string().allow('').optional(),
  BKASH_WEBHOOK_SECRET: Joi.string().allow('').optional(),

  NAGAD_MERCHANT_ID: Joi.string().allow('').optional(),
  NAGAD_API_KEY: Joi.string().allow('').optional(),
  NAGAD_API_SECRET: Joi.string().allow('').optional(),
  NAGAD_WEBHOOK_SECRET: Joi.string().allow('').optional(),

  SSLCOMMERZ_STORE_ID: Joi.string().allow('').optional(),
  SSLCOMMERZ_STORE_PASSWORD: Joi.string().allow('').optional(),
  SSLCOMMERZ_API_KEY: Joi.string().allow('').optional(),
  SSLCOMMERZ_API_SECRET: Joi.string().allow('').optional(),
  SSLCOMMERZ_SANDBOX: Joi.boolean().default(true),

  COD_ENABLED: Joi.boolean().default(true),
  COD_MAX_AMOUNT: Joi.number().positive().default(20000),

  // How long an unpaid online order stays payable before auto-cancellation.
  ORDER_PAYMENT_TTL_MINUTES: Joi.number().integer().positive().default(30),

  SHIPPING_DEFAULT_ZONE_NAME: Joi.string().default('DEFAULT'),

  STEADFAST_BASE_URL: Joi.string()
    .uri()
    .default('https://portal.packzy.com/api/v1'),
  STEADFAST_API_KEY: Joi.string().allow('').optional(),
  STEADFAST_SECRET_KEY: Joi.string().allow('').optional(),
  STEADFAST_WEBHOOK_TOKEN: Joi.string().allow('').optional(),

  PATHAO_BASE_URL: Joi.string()
    .uri()
    .default('https://courier-api-sandbox.pathao.com'),
  PATHAO_CLIENT_ID: Joi.string().allow('').optional(),
  PATHAO_CLIENT_SECRET: Joi.string().allow('').optional(),
  PATHAO_USERNAME: Joi.string().allow('').optional(),
  PATHAO_PASSWORD: Joi.string().allow('').optional(),
  PATHAO_STORE_ID: Joi.string().allow('').optional(),
  PATHAO_WEBHOOK_SECRET: Joi.string().allow('').optional(),
  PATHAO_WEBHOOK_INTEGRATION_SECRET: Joi.string().allow('').optional(),

  STORAGE_DRIVER: Joi.string().valid('local', 's3', 'gcs').default('local'),
  LOCAL_UPLOAD_PATH: Joi.string().default('uploads'),
  LOCAL_ASSET_URL: Joi.string().default('/uploads'),

  AWS_S3_BUCKET: Joi.string().allow('').optional(),
  AWS_REGION: Joi.string().allow('').optional(),
  AWS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  AWS_S3_FORCE_PATH_STYLE: Joi.boolean().default(false),

  GCP_PROJECT_ID: Joi.string().allow('').optional(),
  GCP_BUCKET: Joi.string().allow('').optional(),
  GCP_CREDENTIALS_BASE64: Joi.string().allow('').optional(),

  MAIL_DRIVER: Joi.string().valid('smtp', 'twilio').default('smtp'),
  MAIL_FROM: Joi.string().email().default('no-reply@kinobecho.com'),
  SMTP_HOST: Joi.string().hostname().allow('').optional(),
  SMTP_PORT: Joi.number().port().default(587),
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASS: Joi.string().allow('').optional(),
  SMTP_SECURE: Joi.boolean().default(false),
  SENDGRID_API_KEY: Joi.string().allow('').optional(),

  FCM_SERVICE_ACCOUNT_BASE64: Joi.string().allow('').optional(),
  FCM_PROJECT_ID: Joi.string().allow('').optional(),

  THROTTLE_TTL: Joi.number().integer().positive().default(60000),
  THROTTLE_LIMIT: Joi.number().integer().positive().default(100),
  THROTTLE_AUTH_TTL: Joi.number().integer().positive().default(900000),
  THROTTLE_AUTH_LIMIT: Joi.number().integer().positive().default(5),

  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
    .default('info'),
  LOG_PRETTY: Joi.boolean().default(false),
}).unknown(true);