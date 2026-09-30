import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OtpPurpose } from '@prisma/client';
import { OtpService, generateOtpCode } from '../src/modules/auth/otp.service';
import { PrismaService } from '../src/database/prisma.service';
import { RedisCacheService } from '../src/common/cache/redis-cache.service';
import { NotificationService } from '../src/modules/notification/notification.service';
import { ConfigService } from '@nestjs/config';

/**
 * OTP issuance and verification.
 *
 * The argon2 helpers are real — hashing a code is the one thing the attempt
 * counter depends on, and a mocked `verify` would make these specs pass no
 * matter what the service did. Prisma and Redis are mocked.
 */
describe('OtpService', () => {
  const PHONE = '+8801712345678';

  let prisma: {
    otpCode: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    // Declared so a spec can assert the request path never looks a user up.
    user: { findUnique: ReturnType<typeof vi.fn> };
  };
  let cache: { incrWithTtl: ReturnType<typeof vi.fn> };
  let notifications: { sendTransactionalSms: ReturnType<typeof vi.fn> };
  let config: Record<string, number>;
  let service: OtpService;

  const buildConfig = (overrides: Record<string, number> = {}) => {
    const values: Record<string, number> = {
      'otp.ttlSeconds': 300,
      'otp.maxAttempts': 5,
      'otp.requestLimit': 3,
      'otp.requestWindowSeconds': 600,
      ...overrides,
    };

    return {
      get: (key: string) => values[key],
    } as unknown as ConfigService;
  };

  /** Real Argon2id, seeded with a known code so verification can succeed. */
  let codeHash: string;

  beforeEach(async () => {
    const { hashOtpCode } = await import(
      '../src/common/utils/password.util'
    );
    codeHash = await hashOtpCode('123456');

    prisma = {
      otpCode: {
        create: vi.fn().mockResolvedValue({ id: 'otp-1' }),
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    };

    cache = { incrWithTtl: vi.fn().mockResolvedValue(1) };
    notifications = { sendTransactionalSms: vi.fn().mockResolvedValue({ success: true }) };
    config = {};

    service = new OtpService(
      prisma as unknown as PrismaService,
      cache as unknown as RedisCacheService,
      notifications as unknown as NotificationService,
      buildConfig(config),
    );
  });

  const liveCode = (overrides: Record<string, unknown> = {}) => ({
    id: 'otp-1',
    target: PHONE,
    purpose: OtpPurpose.LOGIN,
    codeHash,
    attempts: 0,
    expiresAt: new Date(Date.now() + 300_000),
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  });

  describe('generateOtpCode', () => {
    it('always produces six digits', () => {
      for (let i = 0; i < 200; i++) {
        expect(generateOtpCode()).toMatch(/^\d{6}$/);
      }
    });
  });

  describe('request', () => {
    it('stores only a hash, never the plaintext code', async () => {
      await service.request(PHONE, OtpPurpose.LOGIN);

      const createArg = prisma.otpCode.create.mock.calls[0]![0] as {
        data: { codeHash: string; target: string; purpose: OtpPurpose };
      };
      // An Argon2id digest, never six digits.
      expect(createArg.data.codeHash).toMatch(/^\$argon2id\$/);
      expect(createArg.data.codeHash).not.toMatch(/^\d{6}$/);
      expect(createArg.data.target).toBe(PHONE);
      expect(createArg.data.purpose).toBe(OtpPurpose.LOGIN);
    });

    it('sets an expiry of ttlSeconds from now', async () => {
      const before = Date.now();
      await service.request(PHONE, OtpPurpose.LOGIN);
      const after = Date.now();

      const { expiresAt } = (
        prisma.otpCode.create.mock.calls[0]![0] as {
          data: { expiresAt: Date };
        }
      ).data;
      const expiresAtMs = expiresAt.getTime();

      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 300_000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 300_000);
    });

    it('texts the code and records an SMS notification log', async () => {
      await service.request(PHONE, OtpPurpose.LOGIN);

      // The generated code is random, so assert the message shape rather than a
      // fixed digit string: it must carry a six-digit code and the TTL.
      const [to, text, templateKey, payload] =
        notifications.sendTransactionalSms.mock.calls[0]! as [
          string,
          string,
          string,
          Record<string, unknown>,
        ];

      expect(to).toBe(PHONE);
      expect(text).toMatch(/\b\d{6}\b/);
      expect(text).toContain('Valid for 5 minutes');
      expect(templateKey).toBe('otp-login');
      expect(payload).toEqual({ purpose: OtpPurpose.LOGIN });
    });

    it('responds identically whether or not the phone is registered', async () => {
      // Nothing in the request path consults the users table, so an unknown and a
      // known number are indistinguishable to the caller.
      const result = await service.request(PHONE, OtpPurpose.LOGIN);

      expect(result).toEqual({ sent: true, expiresInSeconds: 300 });
      expect(prisma.otpCode.create).toHaveBeenCalled();
    });

    it('never consults the users table at all', async () => {
      await service.request(PHONE, OtpPurpose.REGISTER);

      // The strongest form of the anti-enumeration guarantee: the request path
      // does not look at `users` in the first place, so it cannot branch on it.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('blocks the fourth request in the window with 429', async () => {
      cache.incrWithTtl.mockResolvedValue(4);

      await expect(
        service.request(PHONE, OtpPurpose.LOGIN),
      ).rejects.toMatchObject({ status: 429 });

      // Nothing is stored or sent once the limit is hit.
      expect(prisma.otpCode.create).not.toHaveBeenCalled();
      expect(notifications.sendTransactionalSms).not.toHaveBeenCalled();
    });

    it('allows the first three requests and rejects the fourth', async () => {
      let count = 0;
      cache.incrWithTtl.mockImplementation(async () => ++count);

      for (let i = 0; i < 3; i++) {
        await expect(
          service.request(PHONE, OtpPurpose.LOGIN),
        ).resolves.toBeDefined();
      }

      await expect(service.request(PHONE, OtpPurpose.LOGIN)).rejects.toMatchObject(
        { status: 429 },
      );
    });

    it('scopes the rate limit per purpose so one purpose cannot starve another', async () => {
      await service.request(PHONE, OtpPurpose.LOGIN);
      await service.request(PHONE, OtpPurpose.RESET_PASSWORD);

      const keys = cache.incrWithTtl.mock.calls.map((c) => c[0] as string);
      expect(keys[0]).toBe(`otp:req:${OtpPurpose.LOGIN}:${PHONE}`);
      expect(keys[1]).toBe(`otp:req:${OtpPurpose.RESET_PASSWORD}:${PHONE}`);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('applies the configured window as the counter TTL', async () => {
      cache.incrWithTtl.mockResolvedValue(1);
      await service.request(PHONE, OtpPurpose.LOGIN);

      expect(cache.incrWithTtl).toHaveBeenCalledWith(
        `otp:req:${OtpPurpose.LOGIN}:${PHONE}`,
        600,
      );
    });
  });

  describe('verify', () => {
    it('accepts the correct code and consumes it', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(liveCode());

      await expect(
        service.verify(PHONE, '123456', OtpPurpose.LOGIN),
      ).resolves.toEqual({ verified: true });

      expect(prisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('scopes the lookup to the phone and purpose', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(liveCode());

      await service.verify(PHONE, '123456', OtpPurpose.RESET_PASSWORD);

      const where = (
        prisma.otpCode.findFirst.mock.calls[0]![0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where.target).toBe(PHONE);
      expect(where.purpose).toBe(OtpPurpose.RESET_PASSWORD);
      // A code already spent, or past its TTL, is never a candidate.
      expect(where.consumedAt).toBeNull();
      expect(where.expiresAt).toHaveProperty('gt');
    });

    it('rejects an expired code without incrementing attempts', async () => {
      // The query itself filters on expiresAt, so an expired code never comes back.
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await expect(
        service.verify(PHONE, '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow('Invalid or expired code');

      expect(prisma.otpCode.update).not.toHaveBeenCalled();
    });

    it('rejects an already-consumed code', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(null);

      await expect(
        service.verify(PHONE, '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow('Invalid or expired code');
    });

    it('counts a wrong code and does not consume it', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(liveCode({ attempts: 0 }));

      await expect(
        service.verify(PHONE, '999999', OtpPurpose.LOGIN),
      ).rejects.toThrow('Invalid or expired code');

      expect(prisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { attempts: 1 },
      });
    });

    it('invalidates the code on the fifth wrong attempt', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(liveCode({ attempts: 4 }));

      await expect(
        service.verify(PHONE, '999999', OtpPurpose.LOGIN),
      ).rejects.toThrow('Invalid or expired code');

      // attempts becomes 5 and the code is burnt, so the correct code is now dead.
      expect(prisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { attempts: 5, consumedAt: expect.any(Date) },
      });
    });

    it('rejects a code that already used all its attempts', async () => {
      prisma.otpCode.findFirst.mockResolvedValue(liveCode({ attempts: 5 }));

      await expect(
        service.verify(PHONE, '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow('Invalid or expired code');

      // The correct code is refused: the allowance is gone.
      expect(prisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('permits at most five wrong guesses before the code dies', async () => {
      let attempts = 0;
      prisma.otpCode.findFirst.mockImplementation(async () =>
        liveCode({ attempts }),
      );
      prisma.otpCode.update.mockImplementation(async (arg: { data: { attempts?: number } }) => {
        attempts = arg.data.attempts ?? attempts + 1;
        return {};
      });

      for (let i = 1; i <= 5; i++) {
        await expect(
          service.verify(PHONE, '999999', OtpPurpose.LOGIN),
        ).rejects.toThrow('Invalid or expired code');
      }

      // Even the right code cannot rescue it.
      await expect(
        service.verify(PHONE, '123456', OtpPurpose.LOGIN),
      ).rejects.toThrow('Invalid or expired code');
    });

    it('uses the same generic error for wrong, expired and exhausted', async () => {
      const message = 'Invalid or expired code';

      prisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verify(PHONE, '123456', OtpPurpose.LOGIN)).rejects.toThrow(
        message,
      );

      prisma.otpCode.findFirst.mockResolvedValue(liveCode());
      await expect(service.verify(PHONE, '000000', OtpPurpose.LOGIN)).rejects.toThrow(
        message,
      );
    });
  });

  describe('code logging', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
      vi.restoreAllMocks();
    });

    it('does not log the code outside development', async () => {
      process.env.NODE_ENV = 'production';
      const log = vi.spyOn(
        (service as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      );

      await service.request(PHONE, OtpPurpose.LOGIN);

      // No log line may contain a six-digit code outside development.
      expect(
        log.mock.calls.some((call) => /\b\d{6}\b/.test(String(call[0]))),
      ).toBe(false);
    });

    it('logs the code in development', async () => {
      process.env.NODE_ENV = 'development';
      const log = vi.spyOn(
        (service as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      );

      await service.request(PHONE, OtpPurpose.LOGIN);

      expect(
        log.mock.calls.some((call) => /\b\d{6}\b/.test(String(call[0]))),
      ).toBe(true);
    });
  });
});
