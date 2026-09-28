# KinoBecho Code Prompt — Multi-Vendor E-commerce Backend (KinoBecho-api)


---

## PART 1 — Prisma Schema (paste this into `prisma/schema.prisma` yourself first, exactly as-is,
## before running any Kilo Code step below — do not ask Kilo Code to generate the schema)

```prisma
// ============================================================================
// KinoBecho-api — Multi-Vendor E-commerce Prisma Schema (PostgreSQL)
//
// NOTE: If your repo already has a `User` model (likely, since auth/roles
// modules exist), merge the fields below into it instead of duplicating —
// keep whatever model name/casing your repo already uses.
// ============================================================================

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

enum Role {
  SUPER_ADMIN
  ADMIN
  VENDOR
  VENDOR_STAFF
  CUSTOMER
}

enum KycStatus {
  PENDING
  APPROVED
  REJECTED
}

enum VendorStatus {
  PENDING
  ACTIVE
  SUSPENDED
}

enum SaleType {
  RETAIL
  WHOLESALE
  BOTH
}

enum SaleChannel {
  RETAIL
  WHOLESALE
}

enum ProductStatus {
  DRAFT
  ACTIVE
  OUT_OF_STOCK
  ARCHIVED
}

enum OrderStatus {
  PENDING
  CONFIRMED
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELLED
  RETURNED
}

enum PaymentGateway {
  STRIPE
  BKASH
  NAGAD
  SSLCOMMERZ
}

// unified ledger enums — ONE Transaction model replaces separate Payment/Payout models
enum TransactionType {
  PAYMENT    // customer -> platform (order payment)
  PAYOUT     // platform -> vendor (commission-deducted settlement)
  REFUND     // platform -> customer (order refund)
  ADJUSTMENT // manual correction by admin (either direction)
}

enum TransactionDirection {
  CREDIT // money coming IN to the platform
  DEBIT  // money going OUT of the platform
}

enum TransactionStatus {
  PENDING
  COMPLETED
  FAILED
  REVERSED
}

// PLATFORM as a party never needs fromId/toId (it's the system itself)
enum PartyType {
  CUSTOMER
  VENDOR
  PLATFORM
}

enum ReviewStatus {
  PENDING
  APPROVED
  REJECTED
}

enum DiscountType {
  PERCENT
  FIXED
}

enum ChatThreadType {
  BUYER_VENDOR
  BUYER_SUPPORT
}

enum ChatThreadStatus {
  OPEN
  CLOSED
}

enum StorageDriver {
  LOCAL
  S3
  GCS
}

// notification/mail/push
enum NotificationChannel {
  EMAIL
  SMS
  PUSH
}

enum MailDriver {
  SMTP
  TWILIO // Twilio SendGrid Email API — note: Twilio itself is SMS/WhatsApp, email goes via SendGrid
}

enum NotificationStatus {
  QUEUED
  SENT
  FAILED
}

enum CampaignStatus {
  DRAFT
  QUEUED
  SENDING
  COMPLETED
  FAILED
}

enum CampaignAudience {
  ALL_CUSTOMERS
  ALL_VENDORS
  CUSTOM_SEGMENT // resolved via targetFilter json at send time
}

// ---------------------------------------------------------------------------
// USER / AUTH
// ---------------------------------------------------------------------------

model User {
  id            String    @id @default(uuid())
  email         String?   @unique
  phone         String?   @unique
  passwordHash  String
  name          String
  role          Role      @default(CUSTOMER)
  avatarUrl     String?
  isVerified    Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  deletedAt     DateTime?

  vendor              Vendor?               @relation("UserVendor")
  addresses           Address[]
  cart                Cart?
  ordersAsBuyer       Order[]               @relation("OrderBuyer")
  orderStatusChanges  OrderStatusHistory[]  @relation("StatusChangedBy")
  reviews             Review[]
  chatMessagesSent    ChatMessage[]         @relation("MessageSender")
  chatThreadsAsBuyer  ChatThread[]          @relation("ThreadBuyer")
  chatThreadsAsAdmin  ChatThread[]          @relation("ThreadAdmin")
  reviewsModerated    Review[]              @relation("ReviewModerator")
  storageFiles        StorageFile[]         @relation("FileOwnerUser")
  deviceTokens        DeviceToken[]
  notificationLogs    NotificationLog[]

  @@index([role])
  @@map("users")
}

model Address {
  id            String   @id @default(uuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  label         String?
  recipientName String
  phone         String
  line1         String
  line2         String?
  city          String
  district      String?
  postalCode    String?
  country       String   @default("BD")
  isDefault     Boolean  @default(false)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([userId])
  @@map("addresses")
}

// ---------------------------------------------------------------------------
// VENDOR
// ---------------------------------------------------------------------------

model Vendor {
  id                String       @id @default(uuid())
  userId            String       @unique
  user              User         @relation("UserVendor", fields: [userId], references: [id], onDelete: Cascade)
  businessName      String
  slug              String       @unique
  logoUrl           String?
  bannerUrl         String?
  description       String?
  kycStatus         KycStatus    @default(PENDING)
  status            VendorStatus @default(PENDING)
  commissionRate    Decimal      @default(10.0) @db.Decimal(5, 2)
  payoutMethod      String?
  payoutAccountInfo Json?
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt
  deletedAt         DateTime?

  kycDocuments  StorageFile[]        @relation("VendorKycDocs")
  products      Product[]
  orders        Order[]              @relation("OrderVendor")
  transactions  Transaction[]
  coupons       Coupon[]
  chatThreads   ChatThread[]         @relation("ThreadVendor")

  @@index([status])
  @@index([kycStatus])
  @@map("vendors")
}

// ---------------------------------------------------------------------------
// CATEGORY (self-referencing tree)
// ---------------------------------------------------------------------------

model Category {
  id        String     @id @default(uuid())
  name      String
  slug      String     @unique
  imageUrl  String?
  sortOrder Int        @default(0)
  isActive  Boolean    @default(true)
  parentId  String?
  parent    Category?  @relation("CategoryTree", fields: [parentId], references: [id], onDelete: SetNull)
  children  Category[] @relation("CategoryTree")
  products  Product[]
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt

  @@index([parentId])
  @@map("categories")
}

// ---------------------------------------------------------------------------
// PRODUCT
// ---------------------------------------------------------------------------

model Product {
  id              String        @id @default(uuid())
  vendorId        String
  vendor          Vendor        @relation(fields: [vendorId], references: [id], onDelete: Cascade)
  categoryId      String
  category        Category      @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  name            String
  slug            String        @unique
  description     String?
  saleType        SaleType      @default(RETAIL)
  status          ProductStatus @default(DRAFT)
  price           Decimal       @db.Decimal(12, 2)
  minOrderQty     Int?
  countryOfOrigin String?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  deletedAt       DateTime?

  variants   ProductVariant[]
  priceTiers ProductPriceTier[]
  images     ProductImage[]
  reviews    Review[]
  cartItems  CartItem[]

  @@index([vendorId, status])
  @@index([categoryId])
  @@index([saleType])
  // Full-text search needs a follow-up raw SQL migration (Prisma can't declare GIN/tsvector):
  //   ALTER TABLE products ADD COLUMN search_vector tsvector
  //     GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,''))) STORED;
  //   CREATE INDEX products_search_idx ON products USING GIN (search_vector);
  @@map("products")
}

model ProductVariant {
  id              String   @id @default(uuid())
  productId       String
  product         Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  sku             String   @unique
  attributes      Json
  stock           Int      @default(0)
  priceOverride   Decimal? @db.Decimal(12, 2)
  lowStockAlertAt Int      @default(5)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  cartItems  CartItem[]
  orderItems OrderItem[]

  @@index([productId])
  @@map("product_variants")
}

model ProductPriceTier {
  id        String   @id @default(uuid())
  productId String
  product   Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  minQty    Int
  maxQty    Int?
  unitPrice Decimal  @db.Decimal(12, 2)
  createdAt DateTime @default(now())

  @@index([productId, minQty])
  @@map("product_price_tiers")
}

model ProductImage {
  id        String   @id @default(uuid())
  productId String
  product   Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  url       String
  isPrimary Boolean  @default(false)
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())

  @@index([productId, isPrimary])
  @@map("product_images")
}

// ---------------------------------------------------------------------------
// CART
// ---------------------------------------------------------------------------

model Cart {
  id        String     @id @default(uuid())
  userId    String     @unique
  user      User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  items     CartItem[]
  updatedAt DateTime   @updatedAt
  createdAt DateTime   @default(now())

  @@map("carts")
}

model CartItem {
  id               String          @id @default(uuid())
  cartId           String
  cart             Cart            @relation(fields: [cartId], references: [id], onDelete: Cascade)
  productId        String
  product          Product         @relation(fields: [productId], references: [id], onDelete: Cascade)
  productVariantId String?
  productVariant   ProductVariant? @relation(fields: [productVariantId], references: [id], onDelete: SetNull)
  qty              Int
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt

  @@unique([cartId, productId, productVariantId])
  @@index([cartId])
  @@map("cart_items")
}

// ---------------------------------------------------------------------------
// ORDER  (one checkout -> multiple vendor-split Order rows sharing orderGroupId)
// ---------------------------------------------------------------------------

model Order {
  id              String      @id @default(uuid())
  orderGroupId    String
  orderNumber     String      @unique
  buyerId         String
  buyer           User        @relation("OrderBuyer", fields: [buyerId], references: [id], onDelete: Restrict)
  vendorId        String
  vendor          Vendor      @relation("OrderVendor", fields: [vendorId], references: [id], onDelete: Restrict)
  saleChannel     SaleChannel
  status          OrderStatus @default(PENDING)
  subtotal        Decimal     @db.Decimal(12, 2)
  discountTotal   Decimal     @default(0) @db.Decimal(12, 2)
  shippingFee     Decimal     @default(0) @db.Decimal(12, 2)
  grandTotal      Decimal     @db.Decimal(12, 2)
  couponId        String?
  coupon          Coupon?     @relation(fields: [couponId], references: [id], onDelete: SetNull)
  shippingAddress Json
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  items             OrderItem[]
  statusHistory     OrderStatusHistory[]
  transactions      Transaction[]
  transactionOrders TransactionOrder[]

  @@index([orderGroupId])
  @@index([buyerId, status])
  @@index([vendorId, status])
  @@map("orders")
}

model OrderItem {
  id               String         @id @default(uuid())
  orderId          String
  order            Order          @relation(fields: [orderId], references: [id], onDelete: Cascade)
  productVariantId String
  productVariant   ProductVariant @relation(fields: [productVariantId], references: [id], onDelete: Restrict)
  productNameSnap  String
  qty              Int
  unitPrice        Decimal        @db.Decimal(12, 2)
  lineTotal        Decimal        @db.Decimal(12, 2)

  @@index([orderId])
  @@index([productVariantId])
  @@map("order_items")
}

model OrderStatusHistory {
  id          String       @id @default(uuid())
  orderId     String
  order       Order        @relation(fields: [orderId], references: [id], onDelete: Cascade)
  fromStatus  OrderStatus?
  toStatus    OrderStatus
  note        String?
  changedById String?
  changedBy   User?        @relation("StatusChangedBy", fields: [changedById], references: [id], onDelete: SetNull)
  createdAt   DateTime     @default(now())

  @@index([orderId])
  @@map("order_status_history")
}

// ---------------------------------------------------------------------------
// TRANSACTION  (unified ledger — single table for payment IN and payout OUT)
//
//   customer pays for order   -> type=PAYMENT,  direction=CREDIT, from=CUSTOMER, to=PLATFORM
//   platform settles vendor   -> type=PAYOUT,   direction=DEBIT,  from=PLATFORM, to=VENDOR
//   platform refunds customer -> type=REFUND,   direction=DEBIT,  from=PLATFORM, to=CUSTOMER
//   manual admin correction   -> type=ADJUSTMENT, direction=either
//
// PLATFORM party never needs fromId/toId (nullable, only set for CUSTOMER/VENDOR).
// ---------------------------------------------------------------------------

model Transaction {
  id            String               @id @default(uuid())
  type          TransactionType
  direction     TransactionDirection
  status        TransactionStatus    @default(PENDING)
  amount        Decimal              @db.Decimal(12, 2)
  currency      String               @default("BDT")

  fromType      PartyType
  fromId        String?
  toType        PartyType
  toId          String?

  gateway       PaymentGateway?      // set for type=PAYMENT
  externalRef   String?              @unique
  rawResponse   Json?

  payoutMethod  String?              // set for type=PAYOUT
  vendorId      String?
  vendor        Vendor?              @relation(fields: [vendorId], references: [id], onDelete: SetNull)

  orderId       String?              // set for type=PAYMENT/REFUND (single order)
  order         Order?               @relation(fields: [orderId], references: [id], onDelete: SetNull)

  note          String?
  completedAt   DateTime?
  createdAt     DateTime             @default(now())
  updatedAt     DateTime             @updatedAt

  settledOrders TransactionOrder[]   // set for type=PAYOUT settling multiple orders

  @@index([type, status])
  @@index([orderId])
  @@index([vendorId, type, status])
  @@index([fromType, fromId])
  @@index([toType, toId])
  @@map("transactions")
}

model TransactionOrder {
  id            String      @id @default(uuid())
  transactionId String
  transaction   Transaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  orderId       String
  order         Order       @relation(fields: [orderId], references: [id], onDelete: Restrict)

  @@unique([transactionId, orderId])
  @@index([orderId])
  @@map("transaction_orders")
}

// ---------------------------------------------------------------------------
// REVIEW
// ---------------------------------------------------------------------------

model Review {
  id                 String       @id @default(uuid())
  productId          String
  product            Product      @relation(fields: [productId], references: [id], onDelete: Cascade)
  userId             String
  user               User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  rating             Int
  comment            String?
  isVerifiedPurchase Boolean      @default(false)
  status             ReviewStatus @default(PENDING)
  moderatedById      String?
  moderatedBy        User?        @relation("ReviewModerator", fields: [moderatedById], references: [id], onDelete: SetNull)
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  @@unique([productId, userId])
  @@index([productId, status])
  @@map("reviews")
}

// ---------------------------------------------------------------------------
// COUPON
// ---------------------------------------------------------------------------

model Coupon {
  id            String       @id @default(uuid())
  code          String       @unique
  vendorId      String?
  vendor        Vendor?      @relation(fields: [vendorId], references: [id], onDelete: Cascade)
  discountType  DiscountType
  discountValue Decimal      @db.Decimal(12, 2)
  minOrderValue Decimal?     @db.Decimal(12, 2)
  usageLimit    Int?
  usedCount     Int          @default(0)
  expiresAt     DateTime?
  isActive      Boolean      @default(true)
  createdAt     DateTime     @default(now())

  orders Order[]

  @@index([vendorId])
  @@index([isActive, expiresAt])
  @@map("coupons")
}

// ---------------------------------------------------------------------------
// CHAT
// ---------------------------------------------------------------------------

model ChatThread {
  id            String           @id @default(uuid())
  buyerId       String
  buyer         User             @relation("ThreadBuyer", fields: [buyerId], references: [id], onDelete: Cascade)
  vendorId      String?
  vendor        Vendor?          @relation("ThreadVendor", fields: [vendorId], references: [id], onDelete: Cascade)
  adminId       String?
  admin         User?            @relation("ThreadAdmin", fields: [adminId], references: [id], onDelete: SetNull)
  type          ChatThreadType
  status        ChatThreadStatus @default(OPEN)
  lastMessageAt DateTime?
  createdAt     DateTime         @default(now())

  messages          ChatMessage[]
  participantStates ChatParticipantState[]

  @@index([buyerId, vendorId])
  @@index([status])
  @@map("chat_threads")
}

model ChatMessage {
  id            String     @id @default(uuid())
  threadId      String
  thread        ChatThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  senderId      String
  sender        User       @relation("MessageSender", fields: [senderId], references: [id], onDelete: Cascade)
  content       String?
  attachmentUrl String?
  readAt        DateTime?
  createdAt     DateTime   @default(now())
  deletedAt     DateTime?

  @@index([threadId, createdAt])
  @@map("chat_messages")
}

model ChatParticipantState {
  id                String     @id @default(uuid())
  threadId          String
  thread            ChatThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  userId            String
  unreadCount       Int        @default(0)
  lastReadMessageId String?
  isMuted           Boolean    @default(false)
  updatedAt         DateTime   @updatedAt

  @@unique([threadId, userId])
  @@map("chat_participant_states")
}

// ---------------------------------------------------------------------------
// STORAGE
// ---------------------------------------------------------------------------

model StorageFile {
  id           String        @id @default(uuid())
  driver       StorageDriver
  bucketKey    String
  url          String
  mimeType     String
  sizeBytes    Int
  ownerType    String        // "VENDOR_KYC" | "PRODUCT_IMAGE" | "CHAT_ATTACHMENT" | "AVATAR"
  ownerId      String
  vendorId     String?
  vendor       Vendor?       @relation("VendorKycDocs", fields: [vendorId], references: [id], onDelete: Cascade)
  uploadedById String?
  uploadedBy   User?         @relation("FileOwnerUser", fields: [uploadedById], references: [id], onDelete: SetNull)
  createdAt    DateTime      @default(now())

  @@index([ownerType, ownerId])
  @@map("storage_files")
}

// ---------------------------------------------------------------------------
// NOTIFICATION / MAIL / PUSH
// ---------------------------------------------------------------------------

// FCM device token per user, per device — a user can have multiple (phone + tablet + web)
model DeviceToken {
  id         String   @id @default(uuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  token      String   @unique
  platform   String   // "android" | "ios" | "web"
  isActive   Boolean  @default(true)
  lastUsedAt DateTime @default(now())
  createdAt  DateTime @default(now())

  @@index([userId])
  @@map("device_tokens")
}

// single-recipient delivery log for EVERY email/SMS/push sent, whether transactional
// (order confirmation, OTP) or part of a bulk PromotionCampaign
model NotificationLog {
  id          String              @id @default(uuid())
  channel     NotificationChannel
  status      NotificationStatus  @default(QUEUED)
  userId      String?
  user        User?               @relation(fields: [userId], references: [id], onDelete: SetNull)
  recipient   String              // email address, phone number, or device token — kept even if user deleted
  subject     String?             // email only
  templateKey String?             // e.g. "order-confirmation", "promo-blast", "otp"
  payload     Json?               // template variables used, for debugging/resend
  campaignId  String?
  campaign    PromotionCampaign?  @relation(fields: [campaignId], references: [id], onDelete: SetNull)
  providerRef String?             // gateway's own message id
  error       String?
  sentAt      DateTime?
  createdAt   DateTime            @default(now())

  @@index([channel, status])
  @@index([userId])
  @@index([campaignId])
  @@map("notification_logs")
}

// admin-created promotional blast, fanned out into many NotificationLog rows via BullMQ
model PromotionCampaign {
  id            String           @id @default(uuid())
  title         String
  subject       String
  bodyHtml      String
  audience      CampaignAudience
  targetFilter  Json?            // e.g. { "categoryPurchased": "electronics" } — resolved at send time
  status        CampaignStatus   @default(DRAFT)
  createdById   String
  scheduledAt   DateTime?
  sentAt        DateTime?
  totalRecipients Int            @default(0)
  sentCount     Int              @default(0)
  failedCount   Int              @default(0)
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt

  logs NotificationLog[]

  @@index([status])
  @@map("promotion_campaigns")
}
```

After pasting: run `npx prisma format` then `npx prisma generate` yourself to confirm it compiles,
BEFORE giving any step below to Kilo Code.

---

## PART 2 — Ground rules for every Kilo Code step (repeat this block at the top of every step you send)

```
Project: skylane-api, NestJS latest + Prisma (schema already written and migrated — do not modify
prisma/schema.prisma unless a step explicitly says to).
Reuse existing repo conventions exactly:
- Module folder shape: src/modules/<name>/{<name>.module.ts, <name>.controller.ts, <name>.service.ts, dto/}
- Auth/RBAC: common/guards/jwt-auth.guard.ts + common/guards/permissions.guard.ts +
  common/decorators/permissions.decorator.ts + common/decorators/current-user.decorator.ts +
  modules/roles/permissions.registry.ts (add new permission keys here, don't invent a new auth system)
- DB access: database/prisma.service.ts (inject PrismaService, do not create a second Prisma client)
- Validation: class-validator DTOs, matching modules/auth/dto/register.dto.ts style
- Response shape: common/interceptors/transform.interceptor.ts already wraps responses — do not
  wrap responses manually inside controllers
- Errors: throw Nest's built-in exceptions (NotFoundException, ForbiddenException, etc.) — 
  common/filters/global-exception.filter.ts already formats them
- Caching: common/cache/redis-cache.service.ts for any caching need
- Do not add new npm packages beyond what a step explicitly names
Only build what THIS step asks for. Do not scaffold other modules "for completeness."
```

---

## BUILD ORDER — feed ONE step at a time to Kilo Code, in this order

### Step 1 — Cleanup
"Delete these files/folders since they are travel-booking boilerplate not needed for e-commerce:
`src/modules/duffel/`, `src/modules/flights/`, `src/modules/bookings/`,
`src/modules/webhooks/processors/duffel-webhook.processor.ts`. Keep `src/modules/webhooks/` folder
itself (webhooks.module.ts, webhooks.controller.ts, webhooks.service.ts) — it will be reused later."

### Step 2 — Vendor module
"Create `src/modules/vendor/` following the ground rules above. Endpoints:
- `POST /vendors/apply` (CUSTOMER role) — creates a Vendor row with status=PENDING, kycStatus=PENDING
- `GET /vendors/me` (VENDOR role) — vendor's own profile
- `PATCH /vendors/me` (VENDOR role) — update businessName, description, logoUrl, bannerUrl
- `GET /vendors/:slug` (public) — public storefront profile
- `GET /vendors` (ADMIN, permission `vendor:list`) — paginated list, filter by status/kycStatus
- `PATCH /vendors/:id/approve` (ADMIN, permission `vendor:approve`) — sets status=ACTIVE
- `PATCH /vendors/:id/suspend` (ADMIN, permission `vendor:suspend`) — sets status=SUSPENDED
Add permission keys `vendor:list`, `vendor:approve`, `vendor:suspend` to
`modules/roles/permissions.registry.ts`. Use the Vendor Prisma model exactly as already defined."

### Step 3 — Category module
"Create `src/modules/category/` following the ground rules above. Endpoints:
- `POST /categories` (ADMIN, permission `category:manage`) — supports parentId for nesting
- `PATCH /categories/:id` (ADMIN, permission `category:manage`)
- `DELETE /categories/:id` (ADMIN, permission `category:manage`) — soft behavior: block delete if it
  has children or products, return 400 with a clear message instead
- `GET /categories` (public) — return as a nested tree (children recursively included), cache this
  response in Redis for 5 minutes via `RedisCacheService`, invalidate cache on any write
- `GET /categories/:slug` (public)
Add permission key `category:manage`."

### Step 4 — Product module (core + variants + price tiers, no images yet)
"Create `src/modules/product/` following the ground rules above. Endpoints:
- `POST /products` (VENDOR, permission `product:create`) — creates Product + optional nested
  ProductVariant[] + optional nested ProductPriceTier[] in one request (use a Prisma nested write)
- `PATCH /products/:id` (VENDOR, own product only — check `product.vendorId === currentUser.vendor.id`
  in the service before updating; ADMIN can override via permission `product:update:any`)
- `GET /products` (public) — paginated, filter by categoryId, vendorId, saleType, status, search
  (use Postgres `ILIKE` on name for now; full-text tsvector search is added in a later step)
- `GET /products/:slug` (public) — include variants, priceTiers, images, vendor basic info
- `DELETE /products/:id` (VENDOR own or ADMIN) — soft delete (set deletedAt)
Add a `src/modules/product/pricing/product-pricing.service.ts` with a method
`resolveUnitPrice(productId: string, qty: number): Promise<Decimal>` that:
1. Fetches the product's priceTiers ordered by minQty ascending
2. Finds the tier where `minQty <= qty` and (`maxQty is null` or `qty <= maxQty`)
3. If a tier matches, return its unitPrice
4. If no tier matches and product.saleType is RETAIL or BOTH, return product.price
5. Otherwise throw BadRequestException('Quantity does not meet minimum order requirement')
Add permission keys `product:create`, `product:update:own`, `product:update:any`."

### Step 5 — Storage module
"Create `src/modules/storage/` following the ground rules above, plus:
- `src/modules/storage/interfaces/storage-provider.interface.ts`:
  ```typescript
  export interface StorageProvider {
    upload(file: Express.Multer.File, path: string): Promise<{ url: string; key: string }>;
    delete(key: string): Promise<void>;
    getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  }
  ```
- `src/modules/storage/providers/local.provider.ts` — implements StorageProvider, saves under
  `LOCAL_UPLOAD_PATH` env var, serves via a static assets route registered in main.ts
- `src/modules/storage/providers/s3.provider.ts` — implements StorageProvider using
  `@aws-sdk/client-s3` (add this package). Env vars: AWS_S3_BUCKET, AWS_REGION,
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
- `src/modules/storage/providers/gcs.provider.ts` — implements StorageProvider using
  `@google-cloud/storage` (add this package). Env vars: GCP_PROJECT_ID, GCP_BUCKET,
  GCP_CREDENTIALS_BASE64 (decode base64 to JSON credentials at runtime)
- `src/modules/storage/storage.module.ts` — a factory provider that reads `STORAGE_DRIVER` env
  var (`local` | `s3` | `gcs`) and provides the matching StorageProvider implementation under an
  injection token `STORAGE_PROVIDER`
- `src/modules/storage/storage.service.ts` — injects STORAGE_PROVIDER, exposes `uploadFile`,
  `deleteFile`, plus a method `registerFile(driver, key, url, mimeType, sizeBytes, ownerType, ownerId)`
  that writes a StorageFile Prisma row after a successful upload
- `POST /storage/upload` endpoint (any authenticated user), multipart file upload via
  `FileInterceptor`, body also takes `ownerType` and `ownerId`, validates mimetype whitelist
  (images: jpg/png/webp, documents: pdf) and max size (5MB images, 10MB documents) before upload
Add all new env vars to `.env.example`, and add matching entries to `config/configuration.ts` and
`config/env.validation.ts` (extend the existing validation schema there, do not create a second one)."

### Step 6 — Product images (depends on Step 4 + Step 5)
"Extend `src/modules/product/` with:
- `POST /products/:id/images` (VENDOR own product) — accepts multipart file(s), uses
  `StorageService.uploadFile` + creates ProductImage rows, first uploaded image for a product
  auto-sets isPrimary=true if no other image exists yet
- `PATCH /products/:id/images/:imageId/set-primary` (VENDOR own product) — unsets isPrimary on
  other images for that product, sets it on this one (wrap in a Prisma transaction)
- `DELETE /products/:id/images/:imageId` (VENDOR own product) — calls `StorageService.deleteFile`
  then removes the ProductImage row"

### Step 7 — Cart module
"Create `src/modules/cart/` following the ground rules above. Endpoints (all CUSTOMER role,
scoped to `currentUser.id`, auto-create a Cart row on first use if none exists):
- `GET /cart` — return cart with items, each item including resolved unit price via
  `ProductPricingService.resolveUnitPrice(productId, qty)` (call it live, don't store stale prices)
- `POST /cart/items` — body: productId, productVariantId (optional), qty. Validate qty against
  product.minOrderQty if saleType is WHOLESALE. Upsert (same product+variant increments qty).
- `PATCH /cart/items/:id` — update qty
- `DELETE /cart/items/:id`
- `DELETE /cart` — clear all items"

### Step 8 — Order module + order splitting
"Create `src/modules/orders/` following the ground rules above.
- `src/modules/orders/order-splitter.service.ts` with method
  `splitCartIntoOrders(userId: string, checkoutDto: CheckoutDto): Promise<Order[]>` that:
  1. Loads the user's cart with items
  2. Groups items by `product.vendorId`
  3. Generates one shared `orderGroupId` (uuid) for this checkout
  4. For each vendor group, in a single Prisma transaction:
     a. Recompute each line's unitPrice via `ProductPricingService.resolveUnitPrice` (never trust
        any price from the client)
     b. Create one Order row (status=PENDING, saleChannel derived from product.saleType) with
        orderGroupId, subtotal/grandTotal computed server-side, shippingAddress as a JSON snapshot
        of the address the user selected
     c. Create OrderItem rows with productNameSnap and unitPrice snapshotted
     d. Decrement ProductVariant.stock for each item (throw BadRequestException if insufficient stock)
     e. Create one OrderStatusHistory row (fromStatus=null, toStatus=PENDING)
  5. Clear the user's cart
  6. Return the created Order rows
- `POST /orders/checkout` (CUSTOMER) — body: addressId, couponCode (optional) — calls the splitter
- `GET /orders` (CUSTOMER, own orders only, filter by orderGroupId/status, paginated)
- `GET /orders/vendor` (VENDOR, own vendor's orders only, paginated)
- `GET /orders/:id` (owner buyer, owning vendor, or ADMIN)
- `PATCH /orders/:id/status` (owning VENDOR or ADMIN, permission `order:update:own` /
  `order:update:any`) — validates status transitions follow the enum order
  (PENDING->CONFIRMED->PROCESSING->SHIPPED->DELIVERED, or ->CANCELLED from PENDING/CONFIRMED only),
  creates an OrderStatusHistory row on every change
Add permission keys `order:update:own`, `order:update:any`."

### Step 9 — Payments (Stripe already exists — extend with bKash/Nagad/SSLCommerz)
"In `src/modules/payments/providers/`, following the exact same pattern as the existing
`stripe.provider.ts` and `interfaces/payment-gateway.interface.ts`, add:
- `bkash.provider.ts`
- `nagad.provider.ts`
- `sslcommerz.provider.ts`
Each implements the existing `PaymentGatewayInterface`. On successful payment confirmation from
any provider, create ONE `Transaction` row (not a Payment row — that model does not exist, we use
the unified ledger):
```typescript
{
  type: 'PAYMENT',
  direction: 'CREDIT',
  status: 'COMPLETED',
  amount: order.grandTotal,
  currency: 'BDT',
  fromType: 'CUSTOMER',
  fromId: order.buyerId,
  toType: 'PLATFORM',
  toId: null,
  gateway: <BKASH|NAGAD|SSLCOMMERZ|STRIPE>,
  externalRef: <gateway's transaction id>,
  rawResponse: <full gateway response>,
  orderId: order.id,
  completedAt: new Date(),
}
```
In `src/modules/webhooks/processors/`, add `bkash-webhook.processor.ts`,
`nagad-webhook.processor.ts`, `sslcommerz-webhook.processor.ts` following the structure of any
existing processor in that folder, each verifying the webhook signature per that gateway's docs
before creating/updating the Transaction row."

### Step 10 — Payouts module (uses the same Transaction model as Step 9, different type/direction)
"Create `src/modules/payouts/` following the ground rules above.
- `POST /payouts/request` (VENDOR) — body: orderIds[]. Validates all orders belong to this vendor
  and are status=DELIVERED and have no existing PAYOUT transaction already covering them. In a
  transaction: sum (order.grandTotal * (1 - vendor.commissionRate/100)) across the orders, create
  ONE `Transaction` row with type=PAYOUT, direction=DEBIT, status=PENDING, fromType=PLATFORM,
  fromId=null, toType=VENDOR, toId=vendor.id, vendorId=vendor.id, amount=<computed sum>, then
  create a `TransactionOrder` row linking this transaction to each order id.
- `GET /payouts/vendor` (VENDOR, own) — list this vendor's PAYOUT transactions, paginated
- `GET /payouts` (ADMIN, permission `payout:approve`) — list all PAYOUT transactions, filter by status
- `PATCH /payouts/:transactionId/approve` (ADMIN) — sets status=COMPLETED, completedAt=now
- `PATCH /payouts/:transactionId/reject` (ADMIN) — sets status=FAILED, requires a note in the body
Add permission key `payout:approve`. All queries filter `Transaction` by `type = 'PAYOUT'` — do not
create a separate table."

### Step 11 — Reviews module
"Create `src/modules/reviews/` following the ground rules above.
- `POST /products/:productId/reviews` (CUSTOMER) — validate the user has a DELIVERED order
  containing this product before allowing (set isVerifiedPurchase=true if so, else reject with
  ForbiddenException unless you want to allow unverified reviews — confirm this business rule
  with the project owner before assuming either way)
- `GET /products/:productId/reviews` (public, only status=APPROVED, paginated)
- `PATCH /reviews/:id/moderate` (ADMIN, permission `review:moderate`) — body: status
  (APPROVED/REJECTED), sets moderatedById=currentUser.id
Add permission key `review:moderate`."

### Step 12 — Coupons module
"Create `src/modules/coupons/` following the ground rules above.
- `POST /coupons` (VENDOR for their own vendorId, or ADMIN for vendorId=null platform-wide,
  permission `coupon:manage`)
- `POST /coupons/validate` (CUSTOMER, public-ish) — body: code, cartSubtotal — returns computed
  discount amount without applying it, checks expiresAt/usageLimit/minOrderValue
- Applied at checkout time inside `order-splitter.service.ts` from Step 8 (increment usedCount
  in the same transaction as order creation)
Add permission key `coupon:manage`."

### Step 13 — Storage-backed KYC on vendor module (depends on Step 2 + Step 5)
"Extend `src/modules/vendor/` with:
- `POST /vendors/me/kyc-documents` (VENDOR) — multipart upload via StorageService, creates
  StorageFile rows with ownerType='VENDOR_KYC', ownerId=vendor.id, vendorId=vendor.id
- `GET /vendors/:id/kyc-documents` (ADMIN, permission `vendor:approve`) — list a vendor's KYC files
  with signed URLs via `StorageProvider.getSignedUrl`"

### Step 14 — Chat module (build last — depends on User/Vendor already existing)
"Create `src/modules/chat/` following the ground rules above, plus:
- `src/modules/chat/guards/ws-jwt.guard.ts` — a CanActivate guard for WebSocket connections that
  reads the JWT from the socket handshake (`client.handshake.auth.token`), verifies it the same
  way `strategies/jwt.strategy.ts` does, and attaches the decoded user to `client.data.user`
- `src/modules/chat/gateways/chat.gateway.ts` — `@WebSocketGateway({ cors: true })`, using
  `@socket.io/redis-adapter` wired to the SAME Redis connection config used by
  `common/cache/redis-cache.module.ts` (do not open a second Redis connection). Events:
  - `chat:join` — client joins a socket room named by threadId (validate the user is a
    participant of that thread first)
  - `chat:message:send` — body: threadId, content, attachmentUrl (optional). Persists a
    ChatMessage row FIRST, updates ChatThread.lastMessageAt, increments the other participant's
    ChatParticipantState.unreadCount, THEN broadcasts `chat:message:receive` to the room
  - `chat:typing` — broadcasts to room, not persisted
  - `chat:read` — body: threadId, messageId. Updates the caller's ChatParticipantState
    (lastReadMessageId, unreadCount=0), sets ChatMessage.readAt for messages up to that point
  Rate-limit `chat:message:send` to 20 messages per 10 seconds per socket using
  `common/throttling/redis-throttler-storage.ts`'s existing Redis client.
- `chat.controller.ts` REST endpoints (guarded by existing `jwt-auth.guard.ts`):
  - `POST /chat/threads` — body: vendorId (for BUYER_VENDOR) or none (for BUYER_SUPPORT, admin
    gets auto-assigned or left null for a support queue — confirm this business rule before
    assuming). Finds-or-creates a thread.
  - `GET /chat/threads` — current user's threads (as buyer, vendor, or admin), paginated
  - `GET /chat/threads/:id/messages` — paginated message history, DESC by createdAt"

### Step 15 — Mail/Notification module (SMTP + Twilio SendGrid, configurable)
"Create `src/modules/notification/` following the ground rules above, plus:
- `src/modules/notification/interfaces/mail-provider.interface.ts`:
  ```typescript
  export interface MailProvider {
    sendMail(to: string, subject: string, html: string): Promise<{ providerRef: string }>;
  }
  ```
- `src/modules/notification/providers/smtp.provider.ts` — implements MailProvider using
  `nodemailer` (add this package). Env vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_SECURE` (bool), `MAIL_FROM`.
- `src/modules/notification/providers/twilio-sendgrid.provider.ts` — implements MailProvider using
  `@sendgrid/mail` (add this package — note: Twilio itself does SMS/WhatsApp, not email; email
  goes through Twilio's SendGrid product, so this is the correct package for "Twilio for email").
  Env vars: `SENDGRID_API_KEY`, `MAIL_FROM`.
- `src/modules/notification/mail.module.ts` — factory provider reading `MAIL_DRIVER` env var
  (`smtp` | `twilio`), provides the matching MailProvider under injection token `MAIL_PROVIDER`,
  same factory pattern as `storage.module.ts` from Step 5.
- `src/modules/notification/notification.service.ts`:
  - `sendTransactionalEmail(userId, to, subject, templateKey, payload)` — renders a simple HTML
    template (use a basic string-replace templating helper, no heavy template engine needed yet),
    calls MAIL_PROVIDER.sendMail, writes ONE `NotificationLog` row with channel=EMAIL immediately
    (status=QUEUED before send, then update to SENT/FAILED after the call resolves)
  - this is for order confirmations, KYC approval emails, etc. — called directly (not queued)
    since it's single-recipient and low-volume
- `src/modules/notification/notification.controller.ts`:
  - `POST /notifications/device-tokens` (any authenticated user) — body: token, platform. Upserts
    a `DeviceToken` row for `currentUser.id` (unique on token, so re-registering the same token
    just updates userId/isActive/lastUsedAt — handles token reuse after logout/login as different user)
  - `DELETE /notifications/device-tokens/:token` (any authenticated user, own token only)

Also add push notification support:
- `src/modules/notification/interfaces/push-provider.interface.ts`:
  ```typescript
  export interface PushProvider {
    sendToTokens(tokens: string[], title: string, body: string, data?: Record<string,string>):
      Promise<{ successCount: number; failedTokens: string[] }>;
  }
  ```
- `src/modules/notification/providers/fcm.provider.ts` — implements PushProvider using
  `firebase-admin` (add this package). Env var: `FCM_SERVICE_ACCOUNT_BASE64` (decode to JSON
  credentials at runtime, same pattern as GCP credentials in Step 5). On `successCount < tokens.length`,
  set `isActive=false` on the DeviceToken rows Firebase reports as invalid/unregistered — do this
  in the caller, not inside the provider, since the provider should stay a thin wrapper.
- `notification.service.ts` method `sendPushToUser(userId, title, body, data?)` — loads the user's
  active DeviceToken rows, calls PushProvider.sendToTokens, writes one NotificationLog row per
  token with channel=PUSH.
Add `FCM_SERVICE_ACCOUNT_BASE64`, `SMTP_*`, `SENDGRID_API_KEY`, `MAIL_DRIVER`, `MAIL_FROM` to
`.env.example`, `config/configuration.ts`, `config/env.validation.ts`."

### Step 16 — Promotional bulk mail via BullMQ (depends on Step 15)
"Add BullMQ (`@nestjs/bullmq` + `bullmq` packages if not already present — check `package.json`
first since `webhooks` module may already use BullMQ for `duffel-webhook.processor.ts`'s pattern;
reuse the existing Redis/BullMQ connection config if one already exists, do not create a second one).
- Register a queue named `promotion-mail` in `notification.module.ts`.
- `src/modules/notification/promotion-campaign.controller.ts`:
  - `POST /promotions` (ADMIN, permission `promotion:manage`) — creates a `PromotionCampaign` row
    (status=DRAFT)
  - `POST /promotions/:id/send` (ADMIN, permission `promotion:manage`) — resolves the recipient
    list based on `audience`/`targetFilter` (ALL_CUSTOMERS = all users with role=CUSTOMER,
    ALL_VENDORS = all users with role=VENDOR, CUSTOM_SEGMENT = apply targetFilter as a Prisma
    where clause — keep this simple, just support a couple of filter keys like
    `hasOrderedFromCategory` for now), sets campaign.status=QUEUED and
    campaign.totalRecipients=<count>, then enqueues ONE BullMQ job PER BATCH of ~200 recipients
    (not one job per recipient, and not one job for the whole campaign — batching avoids both
    Redis job-payload bloat and single-job timeout on huge campaigns)
  - `GET /promotions` / `GET /promotions/:id` (ADMIN) — includes sentCount/failedCount/status
- `src/modules/notification/processors/promotion-mail.processor.ts` (BullMQ Worker/Processor,
  following whatever processor pattern `webhooks/processors/` already establishes):
  - for each recipient in the batch: call `MAIL_PROVIDER.sendMail`, write a `NotificationLog` row
    (channel=EMAIL, campaignId set), increment `campaign.sentCount` or `campaign.failedCount`
  - on the LAST batch of a campaign finishing, set `campaign.status=COMPLETED`,
    `campaign.sentAt=now()` (or `FAILED` if failedCount === totalRecipients)
  - configure retry: 3 attempts with exponential backoff for transient provider errors, but do NOT
    retry on an invalid-recipient error (permanent failure, mark FAILED immediately)
Add permission key `promotion:manage`."

### Step 17 — Seed data
"Update `prisma/seed.ts` to create: 1 admin user, 3 vendor users (with Vendor rows, status=ACTIVE,
kycStatus=APPROVED), 5 categories (2 with children), 10 products spread across vendors and
categories (mix of RETAIL/WHOLESALE/BOTH saleType, some with ProductPriceTier rows), 2 customer
users with sample Address rows, 1 sample DRAFT `PromotionCampaign` row. Use `bcrypt` to hash a
shared dev password like `Password123!` for all seeded users, print the credentials to console at
the end of the seed script."

---

## Notes for using this with a free-tier model
- Send steps strictly in order — later steps assume earlier modules exist and compile.
- If a step's output looks incomplete or the model seems to have skipped a sub-bullet, re-send just
  that step again rather than proceeding — free models are more prone to dropping requirements
  silently on long instructions.
- After every 2–3 steps, ask it to run `npx tsc --noEmit` (or your existing build script) and fix
  any type errors before moving to the next step, so errors don't compound.