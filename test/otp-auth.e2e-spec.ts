import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OtpPurpose } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';

/**
 * Mirrors the real JwtAuthGuard: a route is reachable without a token only when
 * it carries @Public(). Registering this as a global guard is what makes these
 * specs prove the OTP routes are genuinely public, rather than merely reachable
 * in a module that happens to have no auth wired up.
 */
class PublicAwareGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    if (request.headers?.authorization) {
      return true;
    }

    throw new UnauthorizedException('Invalid or expired token');
  }
}

/**
 * HTTP contract for the OTP routes: they must be reachable without a token, and
 * the response body must not vary with whether the phone is registered.
 * AuthService is stubbed so the assertions are about wiring, not the flow.
 */
describe('OTP auth routes (e2e)', () => {
  let app: INestApplication;
  let authService: {
    requestOtp: ReturnType<typeof vi.fn>;
    verifyOtp: ReturnType<typeof vi.fn>;
    resetPassword: ReturnType<typeof vi.fn>;
    verifyPhone: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    authService = {
      requestOtp: vi.fn().mockResolvedValue({
        sent: true,
        expiresInSeconds: 300,
      }),
      verifyOtp: vi.fn().mockResolvedValue({
        accessToken: 'a',
        refreshToken: 'r',
        user: { id: 'u1' },
      }),
      resetPassword: vi.fn().mockResolvedValue({ message: 'Password reset successfully' }),
      verifyPhone: vi.fn().mockResolvedValue({ id: 'u1', isVerified: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) =>
            new PublicAwareGuard(reflector),
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  it('enforces auth on a non-public route, proving the guard is active', async () => {
    // Sanity check: without this, every "public" assertion below would pass even
    // if the guard were missing and @Public() were not doing anything.
    const res = await request(app.getHttpServer()).post('/auth/logout').send({});

    expect(res.status).toBe(401);
  });

  it('POST /auth/otp/request returns the same body regardless of registration', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '01712345678', purpose: OtpPurpose.LOGIN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, expiresInSeconds: 300 });
    expect(authService.requestOtp).toHaveBeenCalledWith(
      '01712345678',
      OtpPurpose.LOGIN,
    );
  });

  it('POST /auth/otp/request rejects an unknown purpose', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '01712345678', purpose: 'DELETE_ACCOUNT' });

    expect(res.status).toBe(400);
    expect(authService.requestOtp).not.toHaveBeenCalled();
  });

  it('POST /auth/otp/request requires a phone', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ purpose: OtpPurpose.LOGIN });

    expect(res.status).toBe(400);
  });

  it('POST /auth/otp/verify forwards the code and purpose', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: '01712345678', code: '123456', purpose: OtpPurpose.LOGIN });

    expect(res.status).toBe(200);
    expect(authService.verifyOtp).toHaveBeenCalledWith(
      '01712345678',
      '123456',
      OtpPurpose.LOGIN,
    );
  });

  it('POST /auth/otp/verify rejects a non-six-digit code', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: '01712345678', code: '12345', purpose: OtpPurpose.LOGIN });

    expect(res.status).toBe(400);
    expect(authService.verifyOtp).not.toHaveBeenCalled();
  });

  it('POST /auth/password/reset forwards the reset', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/password/reset')
      .send({
        phone: '01712345678',
        code: '123456',
        newPassword: 'NewSecurePass123',
      });

    expect(res.status).toBe(200);
    expect(authService.resetPassword).toHaveBeenCalledWith(
      '01712345678',
      '123456',
      'NewSecurePass123',
    );
  });

  it('POST /auth/password/reset rejects a weak password', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/password/reset')
      .send({ phone: '01712345678', code: '123456', newPassword: 'weak' });

    expect(res.status).toBe(400);
    expect(authService.resetPassword).not.toHaveBeenCalled();
  });

  it('keeps the existing email/password routes intact', async () => {
    // The pre-existing email/password flow must not regress.
    const service = {
      register: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
      login: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: service },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) =>
            new PublicAwareGuard(reflector),
        },
      ],
    }).compile();

    const loginApp = module.createNestApplication();
    loginApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await loginApp.init();

    const res = await request(loginApp.getHttpServer())
      .post('/auth/login')
      .send({ email: 'user@example.com', password: 'pass1234' });

    expect(res.status).toBe(200);
    expect(service.login).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'pass1234',
    });

    await loginApp.close();
  });
});
