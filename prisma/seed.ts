import { PrismaClient, Prisma, SaleType, ProductStatus, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import {
  PERMISSION_KEYS,
  USER_ROLE_PERMISSIONS,
} from '../src/modules/roles/permissions.registry';

const prisma = new PrismaClient();

const DEV_PASSWORD = 'Password123!';

interface SeedProduct {
  name: string;
  description: string;
  categorySlug: string;
  price: number;
  saleType: SaleType;
  minOrderQty?: number;
  stock: number;
  skuPrefix: string;
  tiers?: Array<{ minQty: number; maxQty?: number; unitPrice: number }>;
}

const CATEGORIES = [
  { name: 'Electronics', slug: 'electronics', children: ['mobile-phones', 'laptops'] },
  { name: 'Home & Living', slug: 'home-living', children: ['kitchen'] },
  { name: 'Fashion', slug: 'fashion', children: [] },
];

const VENDORS = [
  {
    email: 'vendor1@kinobecho.dev',
    name: 'Rahim Electronics',
    businessName: 'Rahim Electronics',
    slug: 'rahim-electronics',
    description: 'Wholesale and retail consumer electronics since 2011.',
    commissionRate: 10,
  },
  {
    email: 'vendor2@kinobecho.dev',
    name: 'Karim Home Store',
    businessName: 'Karim Home Store',
    slug: 'karim-home-store',
    description: 'Home appliances, kitchenware and lifestyle goods.',
    commissionRate: 12.5,
  },
  {
    email: 'vendor3@kinobecho.dev',
    name: 'Sadia Fashion House',
    businessName: 'Sadia Fashion House',
    slug: 'sadia-fashion-house',
    description: 'Ready-made garments and fashion accessories.',
    commissionRate: 15,
  },
];

const PRODUCTS: Array<Omit<SeedProduct, 'categorySlug'> & { vendorIndex: number; categorySlug: string }> = [
  {
    vendorIndex: 0,
    name: 'Nova X5 Android Smartphone',
    description: '6.5" AMOLED display, 8GB RAM, 128GB storage.',
    categorySlug: 'mobile-phones',
    price: 32000,
    saleType: SaleType.BOTH,
    minOrderQty: 5,
    stock: 120,
    skuPrefix: 'NOVA-X5',
    tiers: [
      { minQty: 5, maxQty: 19, unitPrice: 31000 },
      { minQty: 20, unitPrice: 29500 },
    ],
  },
  {
    vendorIndex: 0,
    name: 'Nova Tab 11 Tablet',
    description: '11" tablet with stylus support.',
    categorySlug: 'electronics',
    price: 42000,
    saleType: SaleType.RETAIL,
    stock: 40,
    skuPrefix: 'NOVA-TAB11',
  },
  {
    vendorIndex: 0,
    name: 'Vertex Pro 14 Laptop',
    description: '14" ultrabook, 16GB RAM, 512GB SSD.',
    categorySlug: 'laptops',
    price: 125000,
    saleType: SaleType.BOTH,
    minOrderQty: 3,
    stock: 35,
    skuPrefix: 'VERTEX-P14',
    tiers: [
      { minQty: 3, maxQty: 9, unitPrice: 120000 },
      { minQty: 10, unitPrice: 114000 },
    ],
  },
  {
    vendorIndex: 0,
    name: 'Auralis 55" Smart TV',
    description: '4K LED smart TV with voice remote.',
    categorySlug: 'electronics',
    price: 68000,
    saleType: SaleType.RETAIL,
    stock: 60,
    skuPrefix: 'AURALIS-55',
  },
  {
    vendorIndex: 0,
    name: 'SoundBeat Wireless Headphones',
    description: 'Over-ear ANC headphones, 40h battery.',
    categorySlug: 'electronics',
    price: 8500,
    saleType: SaleType.WHOLESALE,
    minOrderQty: 10,
    stock: 200,
    skuPrefix: 'SOUNDBEAT-ANC',
    tiers: [
      { minQty: 10, maxQty: 49, unitPrice: 8000 },
      { minQty: 50, unitPrice: 7400 },
    ],
  },
  {
    vendorIndex: 1,
    name: 'ChefPro Stand Mixer 5L',
    description: '5 litre stand mixer with 10 speed settings.',
    categorySlug: 'kitchen',
    price: 24500,
    saleType: SaleType.BOTH,
    minOrderQty: 2,
    stock: 45,
    skuPrefix: 'CHEFPRO-SM5',
    tiers: [{ minQty: 2, maxQty: 9, unitPrice: 23500 }],
  },
  {
    vendorIndex: 1,
    name: 'HomeGlow Air Fryer 6L',
    description: 'Digital air fryer with 8 presets.',
    categorySlug: 'kitchen',
    price: 9800,
    saleType: SaleType.RETAIL,
    stock: 90,
    skuPrefix: 'HOMEGLOW-AF6',
  },
  {
    vendorIndex: 1,
    name: 'BrewMaster Coffee Maker',
    description: 'Espresso and filter coffee maker, 1.5L.',
    categorySlug: 'home-living',
    price: 14200,
    saleType: SaleType.WHOLESALE,
    minOrderQty: 6,
    stock: 70,
    skuPrefix: 'BREWMASTER-CM',
    tiers: [{ minQty: 6, maxQty: 29, unitPrice: 13600 }],
  },
  {
    vendorIndex: 2,
    name: 'Noor Three-Piece Shalwar Kameez',
    description: 'Cotton three-piece with digital print.',
    categorySlug: 'fashion',
    price: 3200,
    saleType: SaleType.BOTH,
    minOrderQty: 10,
    stock: 300,
    skuPrefix: 'NOOR-3PC',
    tiers: [
      { minQty: 10, maxQty: 49, unitPrice: 2900 },
      { minQty: 50, unitPrice: 2600 },
    ],
  },
  {
    vendorIndex: 2,
    name: 'Urban Runner Sneakers',
    description: 'Lightweight running shoes, unisex sizing.',
    categorySlug: 'fashion',
    price: 4500,
    saleType: SaleType.RETAIL,
    stock: 150,
    skuPrefix: 'URBAN-RUN',
  },
];

const CUSTOMERS = [
  {
    email: 'customer1@kinobecho.dev',
    name: 'Ayesha Rahman',
    phone: '+8801700000001',
    address: {
      label: 'Home',
      recipientName: 'Ayesha Rahman',
      phone: '+8801700000001',
      line1: 'House 12, Road 5, Dhanmondi',
      city: 'Dhaka',
      district: 'Dhaka',
      postalCode: '1209',
    },
  },
  {
    email: 'customer2@kinobecho.dev',
    name: 'Tanvir Hossain',
    phone: '+8801700000002',
    address: {
      label: 'Office',
      recipientName: 'Tanvir Hossain',
      phone: '+8801700000002',
      line1: 'Level 7, Bashundhara City',
      line2: 'Panhathazari',
      city: 'Dhaka',
      district: 'Dhaka',
      postalCode: '1212',
    },
  },
];

/**
 * Ensures a role holds exactly the given permission keys, adding anything the
 * registry gained since the role was created. Idempotent: re-running the seed
 * never duplicates an assignment.
 */
async function syncRolePermissions(roleId: string, keys: string[]) {
  const existing = await prisma.rolePermission.findMany({
    where: { roleId },
    select: { permissionId: true, permission: { select: { key: true } } },
  });

  const existingKeys = new Set(existing.map((row) => row.permission.key));
  const missing = keys.filter((key) => !existingKeys.has(key));

  if (missing.length === 0) {
    return;
  }

  const permissions = await prisma.permission.findMany({
    where: { key: { in: missing } },
    select: { id: true },
  });

  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({
      roleId,
      permissionId: permission.id,
    })),
    skipDuplicates: true,
  });

  console.log(
    `  • role ${roleId}: granted ${missing.length} new permission(s) — ${missing.join(', ')}`,
  );
}

async function main() {
  const hashedPassword = await argon2.hash(DEV_PASSWORD);

  for (const key of PERMISSION_KEYS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: `Permission: ${key}` },
    });
  }

  const superAdminRole = await prisma.role.upsert({
    where: { name: 'super_admin' },
    update: {},
    create: {
      name: 'super_admin',
      description: 'Full access to all system resources',
      isSystem: true,
      permissions: {
        create: PERMISSION_KEYS.map((key) => ({ permission: { connect: { key } } })),
      },
    },
  });

  const vendorRole = await prisma.role.upsert({
    where: { name: 'vendor' },
    update: {},
    create: {
      name: 'vendor',
      description: 'Vendor with storefront and order management',
      permissions: {
        create: USER_ROLE_PERMISSIONS.map((key) => ({
          permission: { connect: { key } },
        })),
      },
    },
  });

  // Role permissions are only nested-created when the role is first inserted, so
  // keys added to the registry after a database was seeded would otherwise never
  // reach that database. This keeps the catalog authoritative on every run.
  await syncRolePermissions(superAdminRole.id, PERMISSION_KEYS);
  await syncRolePermissions(vendorRole.id, USER_ROLE_PERMISSIONS);

  const customerRole = await prisma.role.upsert({
    where: { name: 'customer' },
    update: {},
    create: {
      name: 'customer',
      description: 'Standard shopper',
      permissions: { create: [] },
    },
  });

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@kinobecho.dev' },
    update: {},
    create: {
      email: 'admin@kinobecho.dev',
      password: hashedPassword,
      name: 'KinoBecho Admin',
      phone: '+8801700000000',
      role: UserRole.SUPER_ADMIN,
      roleId: superAdminRole.id,
      isVerified: true,
    },
  });

  const vendors = [];

  for (const vendor of VENDORS) {
    const user = await prisma.user.upsert({
      where: { email: vendor.email },
      update: {},
      create: {
        email: vendor.email,
        password: hashedPassword,
        name: vendor.name,
        role: UserRole.VENDOR,
        roleId: vendorRole.id,
        isVerified: true,
      },
    });

    const record = await prisma.vendor.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        businessName: vendor.businessName,
        slug: vendor.slug,
        description: vendor.description,
        kycStatus: 'APPROVED',
        status: 'ACTIVE',
        commissionRate: new Prisma.Decimal(vendor.commissionRate),
        payoutMethod: 'BKASH',
        payoutAccountInfo: { bkashNumber: '+8801700000099' },
      },
    });

    vendors.push(record);
  }

  const categoryIdsBySlug = new Map<string, string>();

  for (const category of CATEGORIES) {
    const parent = await prisma.category.upsert({
      where: { slug: category.slug },
      update: {},
      create: { name: category.name, slug: category.slug, sortOrder: 0 },
    });

    categoryIdsBySlug.set(category.slug, parent.id);

    for (const [index, childSlug] of category.children.entries()) {
      const childName = childSlug
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');

      const child = await prisma.category.upsert({
        where: { slug: childSlug },
        update: {},
        create: {
          name: childName,
          slug: childSlug,
          parentId: parent.id,
          sortOrder: index,
        },
      });

      categoryIdsBySlug.set(childSlug, child.id);
    }
  }

  for (const product of PRODUCTS) {
    const categoryId = categoryIdsBySlug.get(product.categorySlug);

    if (!categoryId) {
      throw new Error(`Unknown category slug: ${product.categorySlug}`);
    }

    const vendor = vendors[product.vendorIndex];
    const slug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    await prisma.product.upsert({
      where: { slug },
      update: {},
      create: {
        vendorId: vendor.id,
        categoryId,
        name: product.name,
        slug,
        description: product.description,
        saleType: product.saleType,
        status: ProductStatus.ACTIVE,
        price: new Prisma.Decimal(product.price),
        minOrderQty: product.minOrderQty ?? null,
        countryOfOrigin: 'BD',
        variants: {
          create: [
            {
              sku: `${product.skuPrefix}-STD`,
              attributes: { variant: 'Standard' },
              stock: product.stock,
              lowStockAlertAt: 5,
            },
          ],
        },
        priceTiers: product.tiers?.length
          ? {
              create: product.tiers.map((tier) => ({
                minQty: tier.minQty,
                maxQty: tier.maxQty ?? null,
                unitPrice: new Prisma.Decimal(tier.unitPrice),
              })),
            }
          : undefined,
      },
    });
  }

  const customers = [];

  for (const customer of CUSTOMERS) {
    const user = await prisma.user.upsert({
      where: { email: customer.email },
      update: {},
      create: {
        email: customer.email,
        password: hashedPassword,
        name: customer.name,
        phone: customer.phone,
        role: UserRole.CUSTOMER,
        roleId: customerRole.id,
        isVerified: true,
      },
    });

    const existingAddress = await prisma.address.findFirst({
      where: { userId: user.id },
    });

    if (!existingAddress) {
      await prisma.address.create({
        data: {
          userId: user.id,
          ...customer.address,
          isDefault: true,
        },
      });
    }

    customers.push(user);
  }

  const existingCampaign = await prisma.promotionCampaign.findFirst({
    where: { title: 'Eid Sale 2026' },
  });

  if (!existingCampaign) {
    await prisma.promotionCampaign.create({
      data: {
        title: 'Eid Sale 2026',
        subject: 'Eid Sale — up to 20% off electronics',
        bodyHtml:
          '<p>Hi {{name}},</p><p>Our Eid sale is live with up to 20% off electronics and home appliances.</p>',
        audience: 'ALL_CUSTOMERS',
        status: 'DRAFT',
        createdById: adminUser.id,
      },
    });
  }

  const platformCoupon = await prisma.coupon.findUnique({
    where: { code: 'EID2026' },
  });

  if (!platformCoupon) {
    await prisma.coupon.create({
      data: {
        code: 'EID2026',
        discountType: 'PERCENT',
        discountValue: new Prisma.Decimal(10),
        minOrderValue: new Prisma.Decimal(5000),
        usageLimit: 500,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        isActive: true,
      },
    });
  }

  console.log('--------------------------------------------------');
  console.log('Seed completed. All users share the password below');
  console.log('--------------------------------------------------');
  console.log(`Admin:    ${adminUser.email}  (${UserRole.SUPER_ADMIN})`);
  for (const vendor of vendors) {
    console.log(`Vendor:   ${VENDORS[vendors.indexOf(vendor)].email}  (${vendor.businessName})`);
  }
  for (const customer of customers) {
    console.log(`Customer: ${customer.email}`);
  }
  console.log(`Password: ${DEV_PASSWORD}`);
  console.log('--------------------------------------------------');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
