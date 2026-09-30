import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { splitCorsOrigins } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: true,
    rawBody: true,
  });

  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const apiPrefix = configService.get<string>('app.apiPrefix') ?? 'api';
  const version = `v${configService.get<string>('app.apiVersion') ?? '1'}`;

  app.setGlobalPrefix(`${apiPrefix}/${version}`);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      errorHttpStatusCode: 422,
    }),
  );

  const isProduction = configService.get<string>('app.nodeEnv') === 'production';
  app.getHttpAdapter().getInstance().set('trust proxy', isProduction);

  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              scriptSrc: ["'self'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              connectSrc: ["'self'"],
              fontSrc: ["'self'"],
            },
          }
        : false,
      hsts: isProduction
        ? {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true,
          }
        : false,
    }),
  );

  const corsOrigin = configService.get<string>('app.corsOrigin');
  const allowedOrigins = splitCorsOrigins(corsOrigin);

  if (allowedOrigins.length === 0) {
    logger.warn(
      'CORS_ORIGIN resolved to an empty list — CORS is disabled for every origin',
    );
  } else {
    logger.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
  }

  app.enableCors({
    // Fail closed rather than falling back to `*`, which browsers reject on
    // credentialed requests anyway.
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id'],
    credentials: true,
  });

  if (configService.get<boolean>('app.swaggerEnabled')) {
    const isProdSwagger = isProduction;
    const publicUrl = (
      configService.get<string>('app.publicUrl') ??
      `http://localhost:${configService.get<number>('app.port') ?? 3000}`
    ).replace(/\/$/, '');

    const options = new DocumentBuilder()
      .setTitle('KinoBecho API')
      .setDescription(
        [
          'Backend API for **KinoBecho**, a multi-vendor e-commerce marketplace.',
          '',
          '### Highlights',
          '- **Multi-vendor** — vendor onboarding, KYC approval, commission-based settlement',
          '- **Catalog** — nested categories, product variants, wholesale/retail price tiers',
          '- **Orders** — cart checkout split into one order per vendor via `orderGroupId`',
          '- **Ledger** — a single `Transaction` table for payments, payouts, refunds and adjustments',
          '- **Payments** — Stripe, bKash, Nagad and SSLCommerz with signed webhook handling',
          '- **Realtime** — Socket.io chat (buyer↔vendor and buyer↔support) over the Redis adapter',
          '- **Notifications** — transactional email/push plus BullMQ-backed bulk campaigns',
          '- **RBAC** — roles and permissions resolved at runtime and enforced by guards',
          '',
          '### Conventions',
          '- All routes are prefixed with `/api/v1`.',
          '- Request validation returns **422** with the failing fields listed.',
          '- Errors share one envelope: `{ statusCode, message, error, correlationId, timestamp }`.',
          '- Every response carries an `x-correlation-id` header for tracing.',
          '- Authenticated routes use the **access-token** bearer scheme below.',
          '',
          '### Roles',
          '`SUPER_ADMIN`, `ADMIN`, `VENDOR`, `VENDOR_STAFF`, `CUSTOMER` — vendor and admin',
          'routes additionally require permissions resolved through the RBAC module.',
        ].join('\n'),
      )
      .setVersion('1.0.0')
      .setContact('KinoBecho', 'https://kinobecho.com', 'support@kinobecho.com')
      .setLicense('MIT', 'https://opensource.org/licenses/MIT')
      .setExternalDoc('KinoBecho', 'https://kinobecho.com')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          in: 'header',
          name: 'Authorization',
          description:
            'Paste the `accessToken` returned by `POST /api/v1/auth/login`. Do not include the `Bearer ` prefix.',
        },
        'access-token',
      )
      .addTag('auth', 'Registration, login, refresh-token rotation and logout')
      .addTag('users', 'Profile and address book for the authenticated user')
      .addTag('roles', 'Dynamic RBAC: roles, permissions and audit trail')
      .addTag('vendors', 'Vendor onboarding, KYC documents, admin approval and suspension')
      .addTag('categories', 'Nested category tree with Redis caching')
      .addTag('products', 'Products, variants, wholesale price tiers and images')
      .addTag('storage', 'Multi-driver file upload (local, S3, GCS) with signed URLs')
      .addTag('cart', 'Customer cart with live price resolution and stock checks')
      .addTag('orders', 'Checkout, vendor splitting, status transitions')
      .addTag('coupons', 'Vendor and platform coupons with subtotal validation')
      .addTag('payments', 'Payment initiation and confirmation across four gateways')
      .addTag('payouts', 'Vendor payout requests and admin approval workflow')
      .addTag('reviews', 'Product reviews, verified-purchase flag and moderation')
      .addTag('chat', 'Chat threads and messages (REST). Realtime events run over Socket.io')
      .addTag('notifications', 'Device tokens, delivery logs and admin promotions')
      .addTag('webhooks', 'Inbound payment gateway webhooks (signature verified)')
      .addTag('health', 'Liveness and readiness probes')
      .addServer(`${publicUrl}/api/v1`, isProdSwagger ? 'Production' : 'Local Development')
      .build();

    const document = SwaggerModule.createDocument(app, options, {
      extraModels: [],
      operationIdFactory: (controllerKey: string, methodKey: string) =>
        `${controllerKey}_${methodKey}`,
    });

    SwaggerModule.setup(`${apiPrefix}/${version}/docs`, app, document, {
      jsonDocumentUrl: `${apiPrefix}/${version}/docs-json`,
      yamlDocumentUrl: `${apiPrefix}/${version}/docs-yaml`,
      customSiteTitle: 'KinoBecho API Docs',
      explorer: true,
      swaggerOptions: {
        docExpansion: 'list',
        tryItOut: true,
        persistAuthorization: true,
        displayOperationId: true,
        displayRequestDuration: true,
        filter: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 2,
        defaultModelRendering: 'example',
      },
    });
    logger.log(`Swagger documentation enabled at /${apiPrefix}/${version}/docs`);
  }

  const storageDriver = (
    configService.get<string>('storage.driver') ??
    configService.get<string>('STORAGE_DRIVER') ??
    'local'
  ).toLowerCase();

  if (storageDriver === 'local') {
    const uploadPath =
      configService.get<string>('storage.localUploadPath') ??
      configService.get<string>('LOCAL_UPLOAD_PATH') ??
      'uploads';
    const assetPrefix = (
      configService.get<string>('storage.localAssetUrl') ??
      configService.get<string>('LOCAL_ASSET_URL') ??
      '/uploads'
    ).replace(/\/$/, '');

    app.useStaticAssets(path.resolve(uploadPath), { prefix: assetPrefix });
    logger.log(`Serving local uploads from ${path.resolve(uploadPath)}`);
  }

  const port = configService.get<number>('app.port') ?? 3000;
  await app.listen(port, () => {
    logger.log(`Application is running on: http://localhost:${port}`);
  });
}

process.on('unhandledRejection', (reason: Error) => {
  const errorLogger = new Logger('UnhandledRejection');
  errorLogger.error(reason?.message ?? 'Unknown unhandled rejection');
  process.exit(1);
});

bootstrap();
