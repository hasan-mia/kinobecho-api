export const PERMISSIONS = [
  // Auth / Users
  { key: 'users:read', description: 'Read all users' },
  { key: 'users:write', description: 'Create or update users' },
  { key: 'users:delete', description: 'Delete users' },

  // Roles / Permissions
  { key: 'roles:manage', description: 'Manage roles and assign permissions' },
  { key: 'roles:read', description: 'Read role information' },

  // Vendor
  { key: 'vendor:list', description: 'List and filter vendors' },
  { key: 'vendor:approve', description: 'Approve a vendor application / KYC' },
  { key: 'vendor:suspend', description: 'Suspend or reinstate a vendor' },

  // Category
  { key: 'category:manage', description: 'Create, update and delete categories' },

  // Product
  { key: 'product:create', description: 'Create products' },
  { key: 'product:update:own', description: "Update a vendor's own products" },
  { key: 'product:update:any', description: "Update any vendor's products" },
  { key: 'product:delete:own', description: "Delete a vendor's own products" },
  { key: 'product:delete:any', description: "Delete any vendor's products" },

  // Order
  { key: 'order:read:any', description: 'List and read any order across all vendors' },
  { key: 'order:update:own', description: "Update own vendor's orders" },
  { key: 'order:update:any', description: 'Update any order' },

  // Payments / Payouts
  { key: 'payments:create', description: 'Create payments' },
  { key: 'payments:refund', description: 'Refund a payment' },
  { key: 'payments:read', description: 'Read payment information' },
  { key: 'payout:approve', description: 'Approve or reject vendor payouts' },
  { key: 'payout:read', description: 'Read payout information' },

  // Coupons
  { key: 'coupon:manage', description: 'Create and manage coupons' },

  // Reviews
  { key: 'review:moderate', description: 'Approve or reject reviews' },

  // Promotions
  { key: 'promotion:manage', description: 'Create and send promotional campaigns' },

  // Webhooks
  { key: 'webhooks:manage', description: 'Manage webhook endpoints' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export const SYSTEM_PERMISSIONS: PermissionKey[] = ['roles:manage'];

export const USER_ROLE_PERMISSIONS: PermissionKey[] = [
  'product:create',
  'product:update:own',
  'product:delete:own',
  'order:update:own',
  'coupon:manage',
  'payments:create',
];
