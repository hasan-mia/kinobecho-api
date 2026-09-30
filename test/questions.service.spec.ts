import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewStatus, UserRole } from '@prisma/client';
import { QuestionsService } from '../src/modules/questions/questions.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const customer = {
  id: 'buyer-1',
  email: 'buyer@example.com',
  name: 'Buyer',
  role: UserRole.CUSTOMER,
  roleId: null,
  vendor: null,
} as unknown as AuthenticatedUser;

const vendorUser = (vendorId: string) =>
  ({
    id: 'vendor-user',
    email: 'v@example.com',
    name: 'Vendor',
    role: UserRole.VENDOR,
    roleId: null,
    vendor: { id: vendorId, slug: 'v', businessName: 'V', status: 'ACTIVE' },
  }) as unknown as AuthenticatedUser;

const admin = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.SUPER_ADMIN,
  roleId: null,
  vendor: null,
} as unknown as AuthenticatedUser;

const question = (overrides: Record<string, unknown> = {}) => ({
  id: 'q1',
  productId: 'p1',
  userId: 'buyer-1',
  question: 'Does it ship with a warranty card?',
  status: ReviewStatus.APPROVED,
  note: null,
  moderatedById: null,
  answeredAt: null,
  user: { id: 'buyer-1', email: 'buyer@example.com', name: 'Buyer' },
  product: { id: 'p1', name: 'Widget', vendorId: 'vendor-1' },
  ...overrides,
});

describe('QuestionsService.answer — only the owning vendor', () => {
  let prisma: any;
  let notifications: { sendTransactionalEmail: ReturnType<typeof vi.fn> };
  let tx: any;
  let service: QuestionsService;

  beforeEach(() => {
    tx = {
      productAnswer: { create: vi.fn().mockResolvedValue({ id: 'a1', answer: 'Yes' }) },
      productQuestion: { update: vi.fn().mockResolvedValue({}) },
    };

    prisma = {
      productQuestion: {
        findUnique: vi.fn().mockResolvedValue(question()),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue(question({ status: ReviewStatus.PENDING })),
        update: vi.fn().mockResolvedValue(question()),
      },
      product: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', name: 'Widget' }) },
      vendor: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ businessName: 'V', userId: 'vendor-user' }),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'v@example.com' }) },
      $transaction: vi.fn((cb: (client: unknown) => unknown) => cb(tx)),
    };

    notifications = { sendTransactionalEmail: vi.fn().mockResolvedValue({}) };

    service = new QuestionsService(
      prisma as unknown as PrismaService,
      notifications as never,
    );
  });

  it('lets the vendor who owns the product answer', async () => {
    const result = await service.answer(
      vendorUser('vendor-1'),
      'q1',
      { answer: 'Yes, sealed in the box.' },
    );

    expect(result.id).toBe('a1');
  });

  it('refuses a vendor who does not own the product', async () => {
    await expect(
      service.answer(vendorUser('vendor-2'), 'q1', { answer: 'Sure.' }),
    ).rejects.toThrow(/only the vendor who sells this product/i);

    expect(tx.productAnswer.create).not.toHaveBeenCalled();
  });

  it('refuses a customer trying to answer', async () => {
    await expect(
      service.answer(customer, 'q1', { answer: 'Mine.' }),
    ).rejects.toThrow(/only the vendor who sells this product/i);
  });

  it('lets an admin answer, because support can speak for the platform', async () => {
    await expect(
      service.answer(admin, 'q1', { answer: 'Contact us.' }),
    ).resolves.toBeDefined();
  });

  it('marks a vendor answer as such, and an admin answer as not', async () => {
    await service.answer(vendorUser('vendor-1'), 'q1', { answer: 'Yes.' });
    expect(tx.productAnswer.create.mock.calls[0][0].data.isVendor).toBe(true);

    await service.answer(admin, 'q1', { answer: 'Contact us.' });
    expect(tx.productAnswer.create.mock.calls[1][0].data.isVendor).toBe(false);
  });

  it('publishes a pending question, because the vendor has vouched for it', async () => {
    prisma.productQuestion.findUnique.mockResolvedValue(
      question({ status: ReviewStatus.PENDING }),
    );

    await service.answer(vendorUser('vendor-1'), 'q1', { answer: 'Yes.' });

    expect(tx.productQuestion.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        status: ReviewStatus.APPROVED,
        answeredAt: expect.any(Date),
      }),
    );
  });

  it('notifies the asker', async () => {
    await service.answer(vendorUser('vendor-1'), 'q1', { answer: 'Yes.' });

    const call = notifications.sendTransactionalEmail.mock.calls[0]!;
    expect(call[1]).toBe('buyer@example.com');
    expect(call[3]).toBe('product-answer');
  });

  it('still keeps the answer when the notification fails', async () => {
    notifications.sendTransactionalEmail.mockRejectedValue(new Error('SMTP down'));

    await expect(
      service.answer(vendorUser('vendor-1'), 'q1', { answer: 'Yes.' }),
    ).resolves.toBeDefined();

    expect(tx.productAnswer.create).toHaveBeenCalled();
  });

  it('does not answer a question that does not exist', async () => {
    prisma.productQuestion.findUnique.mockResolvedValue(null);

    await expect(
      service.answer(vendorUser('vendor-1'), 'missing', { answer: 'Yes.' }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('QuestionsService.ask', () => {
  let prisma: any;
  let notifications: { sendTransactionalEmail: ReturnType<typeof vi.fn> };
  let service: QuestionsService;

  beforeEach(() => {
    prisma = {
      product: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'p1', name: 'Widget', vendorId: 'vendor-1' }),
      },
      productQuestion: {
        create: vi.fn().mockResolvedValue(question({ status: ReviewStatus.PENDING })),
      },
      vendor: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ businessName: 'V', userId: 'vendor-user' }),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'v@example.com' }) },
    };

    notifications = { sendTransactionalEmail: vi.fn().mockResolvedValue({}) };

    service = new QuestionsService(
      prisma as unknown as PrismaService,
      notifications as never,
    );
  });

  it('files the question as PENDING', async () => {
    await service.ask(customer, 'p1', { question: 'Does it fit a 15-inch laptop?' });

    expect(prisma.productQuestion.create.mock.calls[0][0].data.status).toBe(
      ReviewStatus.PENDING,
    );
  });

  it('notifies the vendor', async () => {
    await service.ask(customer, 'p1', { question: 'Does it fit a 15-inch laptop?' });

    const call = notifications.sendTransactionalEmail.mock.calls[0]!;
    expect(call[3]).toBe('product-question');
    expect(call[1]).toBe('v@example.com');
  });

  it('still returns the question when the vendor has no user to notify', async () => {
    prisma.vendor.findUnique.mockResolvedValue({ businessName: 'V', userId: null });

    await expect(
      service.ask(customer, 'p1', { question: 'Does it fit a 15-inch laptop?' }),
    ).resolves.toBeDefined();
  });

  it('refuses a question on a product that does not exist', async () => {
    prisma.product.findFirst.mockResolvedValue(null);

    await expect(
      service.ask(customer, 'p1', { question: 'Does it fit?' }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('QuestionsService public listing and moderation', () => {
  let prisma: any;
  let service: QuestionsService;

  beforeEach(() => {
    prisma = {
      product: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }) },
      productQuestion: {
        findMany: vi.fn().mockResolvedValue([
          question({ answers: [{ id: 'a1', answer: 'Yes' }] }),
        ]),
        count: vi.fn().mockResolvedValue(1),
        findUnique: vi.fn().mockResolvedValue(question({ id: 'q1' })),
        update: vi.fn().mockResolvedValue(question()),
      },
    };

    prisma.$transaction = vi.fn((args: unknown) =>
      Array.isArray(args) ? Promise.all(args) : args,
    );

    service = new QuestionsService(
      prisma as unknown as PrismaService,
      { sendTransactionalEmail: vi.fn() } as never,
    );
  });

  it('returns only APPROVED questions publicly', async () => {
    await service.listForProduct('p1', { page: 1, limit: 20 });

    // The filter is in the query, so a pending question cannot leak through a
    // forgotten `if`.
    expect(prisma.productQuestion.findMany.mock.calls[0][0].where).toEqual({
      productId: 'p1',
      status: ReviewStatus.APPROVED,
    });
  });

  it('includes the answers', async () => {
    const result = await service.listForProduct('p1', { page: 1, limit: 20 });

    expect(result.items[0]?.answers).toHaveLength(1);
    expect(
      (prisma.productQuestion.findMany.mock.calls[0]![0] as { include: { answers: unknown } })
        .include.answers,
    ).toBeDefined();
  });

  it('returns the pagination envelope', async () => {
    const result = await service.listForProduct('p1', { page: 2, limit: 5 });

    expect(result.meta).toEqual({ total: 1, page: 2, limit: 5, totalPages: 1 });
  });

  it('requires a reason to reject', async () => {
    await expect(
      service.moderate(admin, 'q1', { status: ReviewStatus.REJECTED }),
    ).rejects.toThrow(/reason is required/i);
  });

  it('records the moderator and the reason', async () => {
    await service.moderate(admin, 'q1', {
      status: ReviewStatus.REJECTED,
      reason: 'spam',
    });

    const data = prisma.productQuestion.update.mock.calls[0][0].data;
    expect(data.status).toBe(ReviewStatus.REJECTED);
    expect(data.moderatedById).toBe('admin-1');
    expect(data.note).toBe('spam');
  });

  it('refuses to set a question back to PENDING', async () => {
    await expect(
      service.moderate(admin, 'q1', { status: ReviewStatus.PENDING }),
    ).rejects.toThrow(/only be approved or rejected/i);
  });
});
