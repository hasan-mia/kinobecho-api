<div align="center">

# KinoBecho API

**Multi-vendor e-commerce marketplace backend**

[![NestJS](https://img.shields.io/badge/NestJS-12.x-ea2845?logo=nestjs)](https://nestjs.com)
[![Prisma](https://img.shields.io/badge/Prisma-6.x-2D3748?logo=prisma)](https://prisma.io)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-4169E1?logo=postgresql)](https://postgresql.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`http://localhost:3000/api/v1` · Swagger UI at `/api/v1/docs`

</div>

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Database & Migrations](#database--migrations)
- [API Reference](#api-reference)
- [Realtime Chat](#realtime-chat)
- [RBAC](#rbac)
- [Testing](#testing)
- [Seed Data](#seed-data)
- [Deployment](#deployment)
- [Scripts](#scripts)
- [License](#license)

---

## Overview

KinoBecho is a multi-vendor marketplace where independent vendors list products,
customers buy from multiple vendors in one checkout, and the platform settles
earnings through a single unified ledger.

**What it does:**

- **Multi-vendor marketplace** — vendor applications, KYC approval, commission rates, suspension/reactivate
- **Product catalog** — nested categories, variants with JSON attributes, wholesale/retail price tiers
- **Cart & checkout** — a single cart is split into one order per vendor, grouped by `orderGroupId`
- **Unified ledger** — one `Transaction` table records payments, payouts, refunds and adjustments
- **Payments** — Stripe, bKash, Nagad, SSLCommerz, each behind a common provider interface with signed webhooks
- **Payouts** — vendors request settlement for delivered orders; admins approve or reject
- **Realtime chat** — Socket.io with the Redis adapter, buyer↔vendor and buyer↔support threads
- **Notifications** — transactional email and FCM push, plus BullMQ-backed bulk campaigns
- **Dynamic RBAC** — roles and permissions stored in the database, enforced by guards
- **Observability** — structured Pino logs, `x-correlation-id` propagation, OpenAPI docs

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | NestJS 12, Express platform adapter |
| Language | TypeScript 6 (strict) |
| ORM | Prisma 6 |
| Database | PostgreSQL 15+ |
| Cache / broker | Redis 7 (ioredis) |
| Queues | BullMQ |
| Realtime | Socket.io 4 + `@socket.io/redis-adapter` |
| Auth | JWT (access + refresh rotation), Argon2id |
| Payments | Stripe, bKash, Nagad, SSLCommerz |
| Storage | Local disk, AWS S3, Google Cloud Storage |
| Mail / push | SMTP, SendGrid (Twilio), Firebase Cloud Messaging |
| Validation | class-validator + class-transformer + Joi (env) |
| Security | helmet, CORS, Redis-backed throttling |
| Docs | @nestjs/swagger (OpenAPI 3) |
| Testing | Vitest |
| Deployment | Docker, PM2 |

---

## Architecture

**Request pipeline** — `CorrelationIdMiddleware` attaches a request ID →
`JwtAuthGuard` verifies the token unless the route is `@Public()` →
`PermissionsGuard` and `RolesGuard` enforce RBAC → route handler →
`TransformInterceptor` wraps the response → `LoggingInterceptor` records timing.

**Global guards are registered in that order in `src/app.module.ts`.** Only
`@Public()` skips authentication; authorization always runs.

**Order splitting** — `OrderSplitterService` groups cart items by vendor,
creates one `Order` per vendor under a shared `orderGroupId`, reserves stock,
and links settlement rows through `TransactionOrder`.

**Money** — amounts are `Decimal(12,2)`, never floats. Every monetary movement
writes a `Transaction` row with a direction (`CREDIT`/`DEBIT`) and a party pair
(`CUSTOMER`/`VENDOR`/`PLATFORM`), so balances are always derivable.

---

## Project Structure

```
kinobecho-api/
├── prisma/
│   ├── schema.prisma           # Source of truth — single full schema
│   ├── staged-schemas/         # Auto-generated cumulative snapshots (01–09)
│   ├── migrations/             # Staged migration history, one folder per stage
│   └── seed.ts                 # Admin, vendors, categories, products, customers
├── scripts/
│   ├── generate-staged-schemas.mjs   # Regenerates prisma/staged-schemas/
│   ├── generate-migrations-diff.sh   # Regenerates prisma/migrations/ from the stages
│   ├── setup-db.sh
│   ├── docker-entrypoint.sh
│   └── healthcheck.sh
├── src/
│   ├── main.ts                 # Bootstrap: prefix, CORS, helmet, Swagger, static assets
│   ├── app.module.ts           # Root module, global guards/filters/interceptors
│   ├── config/
│   │   ├── configuration.ts    # Typed config namespaces via registerAs()
│   │   └── env.validation.ts   # Joi schema for env vars
│   ├── database/
│   │   ├── prisma.service.ts
│   │   └── prisma.module.ts    # @Global
│   ├── common/
│   │   ├── decorators/         # @CurrentUser, @Roles, @RequirePermissions, @Public
│   │   ├── filters/            # GlobalExceptionFilter — uniform error envelope
│   │   ├── guards/             # JwtAuthGuard, PermissionsGuard, RolesGuard
│   │   ├── interceptors/       # TransformInterceptor, LoggingInterceptor
│   │   ├── middleware/         # CorrelationIdMiddleware
│   │   ├── cache/              # RedisCacheModule, RedisIoModule, RedisCacheService
│   │   ├── pipes/              # ValidationPipe factory
│   │   ├── throttling/         # RedisThrottlerStorage
│   │   └── utils/              # slug.util.ts
│   └── modules/
│       ├── auth/               # Register, login, refresh rotation, logout (Argon2id)
│       ├── users/              # Profile, address book, admin role change
│       ├── roles/              # Dynamic RBAC + permission catalog + audit log
│       ├── vendor/             # Apply, profile, KYC docs, approve/suspend/reactivate
│       ├── category/           # Nested tree, Redis-cached
│       ├── product/            # Products, variants, price tiers, images
│       ├── storage/            # Local / S3 / GCS upload, signed URLs
│       ├── cart/               # Live price resolution, stock and min-qty checks
│       ├── orders/             # Checkout, OrderSplitterService, status workflow
│       ├── coupons/            # Vendor + platform coupons, subtotal validation
│       ├── payouts/            # Settlement requests and admin approval
│       ├── reviews/            # Reviews, verified-purchase flag, moderation
│       ├── payments/           # Provider interface + Stripe/bKash/Nagad/SSLCommerz
│       ├── webhooks/           # Signature-verified inbound gateway webhooks
│       ├── chat/               # Socket.io gateway + REST, Redis adapter
│       ├── notification/       # Mail/push providers, BullMQ promo campaigns
│       └── health/             # Liveness/readiness (DB, Redis)
├── test/
├── docker/
├── ecosystem.config.js         # PM2
└── package.json
```

---

## Quick Start

**Prerequisites:** Node.js 20+, PostgreSQL 15+, Redis 7+

### 1. Install

```bash
npm ci
```

### 2. Configure

```bash
cp .env.example .env
```

Minimum required values:

```env
NODE_ENV=development
PORT=3000
CORS_ORIGIN=http://localhost:3000
SWAGGER_ENABLED=true
DATABASE_URL=postgresql://user:pass@localhost:5432/kinobecho

REDIS_HOST=localhost
REDIS_PORT=6379

JWT_ACCESS_SECRET=<32+ char secret>
JWT_REFRESH_SECRET=<32+ char secret>
```

### 3. Database

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed
```

### 4. Run

```bash
npm run start:dev
```

| URL | Description |
|-----|-------------|
| `http://localhost:3000/api/v1` | API root |
| `http://localhost:3000/api/v1/docs` | Swagger UI |
| `http://localhost:3000/api/v1/docs-json` | OpenAPI JSON |
| `http://localhost:3000/api/v1/docs-yaml` | OpenAPI YAML |
| `http://localhost:3000/api/v1/health` | Health check |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | `development` \| `production` \| `test` | `development` |
| `PORT` | HTTP port | `3000` |
| `API_PREFIX` | Global route prefix | `api` |
| `API_VERSION` | Route version segment | `1` |
| `PUBLIC_URL` | Public base URL used for the Swagger server entry | `http://localhost:<PORT>` |
| `CORS_ORIGIN` | Allowed origins, comma-separated | — |
| `SWAGGER_ENABLED` | Expose `/api/v1/docs` | `false` |
| **Database** |||
| `DATABASE_URL` | PostgreSQL connection string | — |
| `DATABASE_PROVIDER` | `postgresql` \| `mysql` \| `mongodb` | `postgresql` |
| **Redis** |||
| `REDIS_HOST` / `REDIS_PORT` | Redis endpoint | `localhost` / `6379` |
| `REDIS_PASSWORD` | Redis auth | — |
| `REDIS_DB` | Redis database index | `0` |
| **JWT** |||
| `JWT_ACCESS_SECRET` | Access token secret | — |
| `JWT_ACCESS_EXPIRES_IN` | Access token TTL | `15m` |
| `JWT_REFRESH_SECRET` | Refresh token secret | — |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | `7d` |
| **Storage** |||
| `STORAGE_DRIVER` | `local` \| `s3` \| `gcs` | `local` |
| `LOCAL_UPLOAD_PATH` | Local upload directory | `uploads` |
| `LOCAL_ASSET_URL` | Public prefix for local files | `/uploads` |
| `AWS_S3_BUCKET` / `AWS_REGION` | S3 target | — |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 credentials | — |
| `GCP_PROJECT_ID` / `GCP_BUCKET` | GCS target | — |
| `GCP_CREDENTIALS_BASE64` | Base64 service account JSON | — |
| **Mail & push** |||
| `MAIL_DRIVER` | `smtp` \| `twilio` | `smtp` |
| `MAIL_FROM` | Sender address | `no-reply@kinobecho.com` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | SMTP settings | `587` |
| `SENDGRID_API_KEY` | SendGrid key (when `MAIL_DRIVER=twilio`) | — |
| `FCM_SERVICE_ACCOUNT_BASE64` | Base64 Firebase service account | — |
| `FCM_PROJECT_ID` | Firebase project | — |
| **Payments** |||
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PUBLISHABLE_KEY` | Stripe | — |
| `BKASH_APP_KEY` / `BKASH_APP_SECRET` / `BKASH_USERNAME` / `BKASH_PASSWORD` / `BKASH_WEBHOOK_SECRET` | bKash | — |
| `NAGAD_MERCHANT_ID` / `NAGAD_API_KEY` / `NAGAD_API_SECRET` / `NAGAD_WEBHOOK_SECRET` | Nagad | — |
| `SSLCOMMERZ_STORE_ID` / `SSLCOMMERZ_STORE_PASSWORD` / `SSLCOMMERZ_API_KEY` / `SSLCOMMERZ_API_SECRET` / `SSLCOMMERZ_SANDBOX` | SSLCommerz | — |
| **Rate limiting** |||
| `THROTTLE_TTL` / `THROTTLE_LIMIT` | Global window (ms) and max requests | `60000` / `100` |
| `THROTTLE_AUTH_TTL` / `THROTTLE_AUTH_LIMIT` | Auth-specific window and max | `900000` / `5` |
| **Logging** |||
| `LOG_LEVEL` | Pino level | `info` |
| `LOG_PRETTY` | Human-readable logs in dev | `false` |

See `.env.example` for the full annotated list.

---

## Database & Migrations

`prisma/schema.prisma` is the single source of truth. Migrations are split into
**nine logical stages** instead of one monolithic file, so each area of the
schema can be reviewed, reverted, or reasoned about on its own.

| Stage | Migration | Contents |
|-------|-----------|----------|
| 1 | `auth_rbac` | `Role`, `Permission`, `RolePermission`, `RoleAuditLog`, `RefreshToken`, `User`, `Address` |
| 2 | `vendor` | `Vendor` with KYC status, commission rate, payout details |
| 3 | `category_product` | `Category`, `Product`, `ProductVariant`, `ProductPriceTier`, `ProductImage` |
| 4 | `cart_order` | `Cart`, `CartItem`, `Order`, `OrderItem`, `OrderStatusHistory` |
| 5 | `transaction` | `Transaction` ledger, `TransactionOrder` settlement links |
| 6 | `review_coupon` | `Review`, `Coupon` |
| 7 | `chat` | `ChatThread`, `ChatMessage`, `ChatParticipantState` |
| 8 | `storage_notification` | `StorageFile`, `DeviceToken`, `NotificationLog`, `PromotionCampaign` |
| 9 | `infra` | `WebhookEvent`, `QueueEvent`, `Session` |

**How the stages work.** `prisma/staged-schemas/` holds nine *cumulative*
snapshots. Early stages include later models as id-only stubs so the relation
graph stays valid while the underlying tables are still empty. Each migration is
a `prisma migrate diff` between consecutive stages, so the SQL only ever adds
columns — nothing is renamed or dropped along the way.

```bash
# Regenerate staged schemas after editing prisma/schema.prisma
npm run prisma:stages

# Also write resolved relation names back into prisma/schema.prisma
npm run prisma:stages:write

# Rebuild every migration folder from the stages (no DB required)
npm run prisma:migrations:staged
```

The last stage is diffed against `prisma/schema.prisma` on every run; a warning
means the source schema and the staged snapshot have diverged.

**Applying migrations**

```bash
npm run prisma:migrate          # dev — creates and applies a new migration
npm run prisma:migrate:deploy   # prod/CI — applies pending migrations only
npm run prisma:studio           # browse data
```

---

## API Reference

Base path: `/api/v1` · 17 tags · 71 paths · 90 operations

The list below is generated from the live OpenAPI document. Every endpoint,
parameter and schema is documented at **`/api/v1/docs`**.

### Auth — `auth`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | Register a customer account |
| `POST` | `/auth/login` | Authenticate, returns access + refresh tokens |
| `POST` | `/auth/refresh` | Rotate a refresh token |
| `POST` | `/auth/logout` | Revoke the current refresh token |

### Users — `users`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/users/me` | Current user profile |
| `GET` | `/users/me/addresses` | List saved addresses |
| `POST` | `/users/me/addresses` | Add an address |
| `PATCH` | `/users/me/addresses/{id}` | Update an address |
| `DELETE` | `/users/me/addresses/{id}` | Delete an address |
| `GET` | `/users` | Admin — list all users |
| `GET` | `/users/{id}` | Admin — user detail |
| `PATCH` | `/users/{id}/role` | Admin — change a user's role |
| `DELETE` | `/users/{id}` | Admin — delete a user |

### Roles & Permissions — `roles`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/roles` | List roles |
| `POST` | `/roles` | Create a role |
| `GET` | `/roles/{id}` | Role detail |
| `PATCH` | `/roles/{id}` | Update a role |
| `DELETE` | `/roles/{id}` | Delete a role |
| `PATCH` | `/roles/{id}/permissions` | Replace a role's permission set |
| `GET` | `/roles/permissions/catalog` | All assignable permission keys |

### Vendors — `vendors`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/vendors/apply` | Apply to become a vendor |
| `GET` | `/vendors/me` | Own vendor profile |
| `PATCH` | `/vendors/me` | Update own profile |
| `POST` | `/vendors/me/kyc-documents` | Upload KYC documents |
| `GET` | `/vendors/me/kyc-documents` | Own KYC documents |
| `GET` | `/vendors` | Public list of active vendors |
| `GET` | `/vendors/{slug}` | Public storefront by slug |
| `GET` | `/vendors/{id}/detail` | Admin — vendor detail |
| `GET` | `/vendors/{id}/kyc-documents` | Admin — KYC docs with signed URLs |
| `PATCH` | `/vendors/{id}/approve` | Admin — approve a vendor |
| `PATCH` | `/vendors/{id}/suspend` | Admin — suspend a vendor |
| `PATCH` | `/vendors/{id}/reactivate` | Admin — lift a suspension |

### Categories — `categories`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/categories` | Public nested tree (Redis-cached) |
| `GET` | `/categories/{slug}` | Public category by slug |
| `POST` | `/categories` | Admin — create (supports `parentId`) |
| `PATCH` | `/categories/{id}` | Admin — update |
| `DELETE` | `/categories/{id}` | Admin — delete (blocked while children or products exist) |

### Products — `products`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/products` | Public list — filter by category, vendor, saleType, status, search |
| `GET` | `/products/{slug}` | Public detail with variants, price tiers and images |
| `POST` | `/products` | Vendor — create with nested variants and price tiers |
| `PATCH` | `/products/{id}` | Vendor (own) or admin (any) — update |
| `DELETE` | `/products/{id}` | Vendor (own) or admin — soft delete |
| `PATCH` | `/products/{id}/variants/{variantId}` | Update a variant |
| `POST` | `/products/{id}/images` | Upload product images |
| `PATCH` | `/products/{id}/images/{imageId}/set-primary` | Set the primary image |
| `DELETE` | `/products/{id}/images/{imageId}` | Delete an image |

### Cart — `cart`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cart` | Cart with live price resolution |
| `POST` | `/cart/items` | Add an item (validates stock and `minOrderQty`) |
| `PATCH` | `/cart/items/{id}` | Update quantity |
| `DELETE` | `/cart/items/{id}` | Remove an item |
| `DELETE` | `/cart` | Empty the cart |

### Orders — `orders`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/orders/checkout` | Checkout — splits the cart into one order per vendor |
| `GET` | `/orders` | Customer — own orders |
| `GET` | `/orders/vendor` | Vendor — own orders |
| `GET` | `/orders/{id}` | Order detail (buyer, vendor or admin) |
| `PATCH` | `/orders/{id}/status` | Vendor or admin — validated status transition |

### Payments — `payments`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/payments/order/{orderId}` | Create a payment for an order on a chosen gateway |
| `GET` | `/payments/order/{orderId}` | Payment status for an order |
| `GET` | `/payments` | List payments (scoped by role) |
| `POST` | `/payments/refund` | Refund a settled payment |

### Webhooks — `webhooks`

Signature-verified inbound callbacks, one per gateway:

`POST /webhooks/stripe` · `POST /webhooks/bkash` · `POST /webhooks/nagad` · `POST /webhooks/sslcommerz`

### Payouts — `payouts`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/payouts/request` | Vendor — request settlement for delivered orders |
| `GET` | `/payouts/vendor` | Vendor — own payouts |
| `GET` | `/payouts` | Admin — all payouts |
| `PATCH` | `/payouts/{transactionId}/approve` | Admin — approve |
| `PATCH` | `/payouts/{transactionId}/reject` | Admin — reject |

### Reviews — `reviews`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/reviews/products/{productId}/reviews` | Create a review (verified purchase flagged) |
| `GET` | `/reviews/products/{productId}/reviews` | Approved reviews for a product |
| `GET` | `/reviews/products/{productId}/reviews/rating-summary` | Aggregate rating breakdown |
| `PATCH` | `/reviews/{id}/moderate` | Admin — approve or reject |

### Coupons — `coupons`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/coupons` | List coupons (vendor-scoped or platform) |
| `POST` | `/coupons` | Vendor (own) or admin (platform) — create |
| `POST` | `/coupons/validate` | Validate a code against an order subtotal |

### Storage — `storage`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/storage/upload` | Upload a file (multipart) via the configured driver |
| `GET` | `/storage/file/{id}/signed-url` | Time-limited access URL |
| `DELETE` | `/storage/file/{id}` | Delete a stored file |

### Chat — `chat`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat/threads` | Create or find a thread (buyer↔vendor or buyer↔support) |
| `GET` | `/chat/threads` | The caller's threads |
| `GET` | `/chat/threads/{id}/messages` | Paginated message history |
| `PATCH` | `/chat/threads/{id}/assign` | Admin — assign a support agent to a thread |

Realtime messaging runs over Socket.io — see [Realtime Chat](#realtime-chat).

### Notifications & Promotions — `notifications` / `promotions`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/notifications/device-tokens` | Register an FCM device token |
| `DELETE` | `/notifications/device-tokens/{token}` | Remove a device token |
| `POST` | `/promotions` | Admin — create a campaign (starts `DRAFT`) |
| `POST` | `/promotions/{id}/send` | Admin — queue the campaign through BullMQ |
| `GET` | `/promotions` | Admin — list campaigns |
| `GET` | `/promotions/{id}` | Campaign detail with per-recipient delivery logs |

### Health — `health`

`GET /health` — database and Redis reachability.

---

## Realtime Chat

Socket.io is served on the same HTTP server. Authenticate during the handshake:

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: { token: accessToken },
  transports: ['websocket'],
});
```

**Client → server** — each handler also returns an acknowledgement, so
`emit(event, payload, ack)` gives you `{ success: true }` or
`{ success: false, error }` directly.

| Event | Payload | Notes |
|-------|---------|-------|
| `chat:join` | `{ threadId }` | Validates the caller is a participant, then joins the room |
| `chat:message:send` | `{ threadId, content, attachmentUrl? }` | Persists, bumps `lastMessageAt`, increments unread counts. Rate limited to 20 messages / 10s per socket |
| `chat:typing` | `{ threadId }` | Broadcast to the room as `{ userId, userName }`, not persisted |
| `chat:read` | `{ threadId, messageId? }` | Marks messages read, resets the unread counter |

**Server → client**

| Event | Payload |
|-------|---------|
| `chat:message:receive` | The persisted message, emitted to everyone in the thread room |
| `chat:typing` | `{ userId, userName }` |
| `chat:read` | `{ userId, messageId }` |

The gateway runs behind `@socket.io/redis-adapter` on the existing Redis
connection, so it scales across multiple instances without a second client.

---

## RBAC

Permissions are **not** hardcoded. Roles and permissions live in the database and
are enforced at request time.

- `@Roles('ADMIN', 'SUPER_ADMIN')` — coarse role check
- `@RequirePermissions('vendor.approve')` — fine-grained permission check
- `@Public()` — opt out of `JwtAuthGuard`; authorization still runs

The full permission catalog is served by `GET /api/v1/roles/permissions/catalog`.
Every permission change writes a `RoleAuditLog` row.

**Roles:** `SUPER_ADMIN` · `ADMIN` · `VENDOR` · `VENDOR_STAFF` · `CUSTOMER`

---

## Testing

```bash
npm test              # run the suite
npm run test:watch    # watch mode
npm run test:cov      # coverage
npm run typecheck     # tsc --noEmit
npm run lint:check    # eslint, no autofix
npm run format:check  # prettier
```

---

## Seed Data

`npm run prisma:seed` creates a working dataset:

- **Admin** — `admin@kinobecho.dev` (`SUPER_ADMIN`)
- **Vendors** — `vendor1@`, `vendor2@`, `vendor3@kinobecho.dev` (active, KYC approved)
- **Categories** — 5, including 2 with children
- **Products** — 10 across vendors and categories, with variants and price tiers
- **Customers** — `customer1@`, `customer2@kinobecho.dev` with addresses
- **Campaign** — one `DRAFT` promo campaign
- **Coupon** — `EID2026` (10% off, minimum 5000 BDT)

> All seeded accounts share the password `Password123!`.
> Development credentials only — never seed a production database.

---

## Deployment

**Docker**

```bash
docker compose -f docker/docker-compose.yml up --build          # dev
docker compose -f docker/docker-compose.prod.yml up --build -d  # prod
```

**PM2**

```bash
npm run pm2:dev
npm run pm2:prod
```

**Production checklist**

- `NODE_ENV=production`
- `SWAGGER_ENABLED=false` unless the docs should be public
- Strong, unique `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`
- Helmet HSTS and CSP are enabled automatically in production
- `trust proxy` is enabled in production for correct client IPs
- `CORS_ORIGIN` set to the exact frontend origins, comma-separated
- Run `npm run prisma:migrate:deploy` before starting the app

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run start:dev` | Development server with watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run lint` / `lint:check` | ESLint, with and without autofix |
| `npm run format` / `format:check` | Prettier |
| `npm run typecheck` | TypeScript without emit |
| `npm test` / `test:watch` / `test:cov` | Vitest |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:migrate` | Create and apply a migration (dev) |
| `npm run prisma:migrate:deploy` | Apply pending migrations (prod/CI) |
| `npm run prisma:seed` | Seed the database |
| `npm run prisma:studio` | Prisma Studio |
| `npm run prisma:stages` | Regenerate `prisma/staged-schemas/` |
| `npm run prisma:stages:write` | Regenerate stages and write relation names back to the source schema |
| `npm run prisma:migrations:staged` | Rebuild all staged migration folders |
| `npm run db:setup` | Database bootstrap helper |
| `npm run docker:dev` / `docker:prod` | Docker Compose |
| `npm run pm2:dev` / `pm2:prod` | PM2 |

---

## License

MIT — see [LICENSE](LICENSE)
