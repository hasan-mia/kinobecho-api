import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpPurpose } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { NotificationService } from '../notification/notification.service';
import { hashOtpCode, verifyOtpCode } from '../../common/utils/password.util';

export const OTP_CODE_LENGTH = 6;

/** Cryptographically uniform, so a code is never biased toward low digits. */
export function generateOtpCode(length = OTP_CODE_LENGTH): string {
  return randomInt(0, 10 ** length).toString().padStart(length, '0');
}

export interface OtpRequestResult {
  /** Deliberately carries no information about whether the phone is known. */
  sent: true;
  expiresInSeconds: number;
}

export interface OtpVerifyResult {
  verified: true;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
    private readonly notifications: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  private ttlSeconds(): number {
    return this.configService.get<number>('otp.ttlSeconds') ?? 300;
  }

  private maxAttempts(): number {
    return this.configService.get<number>('otp.maxAttempts') ?? 5;
  }

  private requestLimit(): number {
    return this.configService.get<number>('otp.requestLimit') ?? 3;
  }

  private requestWindowSeconds(): number {
    return this.configService.get<number>('otp.requestWindowSeconds') ?? 600;
  }

  private rateLimitKey(phone: string, purpose: OtpPurpose): string {
    return `otp:req:${purpose}:${phone}`;
  }

  /**
   * Issues a code for `phone` and texts it.
   *
   * The response is identical whether or not the phone belongs to a registered
   * user, so this endpoint cannot be used to enumerate accounts. Note what that
   * costs: a LOGIN code is sent to unregistered numbers too, and the user only
   * discovers at verify time that the account does not exist.
   */
  async request(phone: string, purpose: OtpPurpose): Promise<OtpRequestResult> {
    const limit = this.requestLimit();
    const window = this.requestWindowSeconds();

    // Per-phone rather than per-IP: one attacker must not be able to burn a
    // victim's SMS quota, and many addresses must not be able to bypass the cap.
    const count = await this.cache.incrWithTtl(
      this.rateLimitKey(phone, purpose),
      window,
    );

    if (count > limit) {
      this.logger.warn(
        `OTP request limit exceeded for ${phone} (purpose ${purpose})`,
      );
      // This Nest version has no TooManyRequestsException, so 429 is raised
      // explicitly to match the documented response for this endpoint.
      throw new HttpException(
        'Too many verification requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + this.ttlSeconds() * 1000);

    await this.prisma.otpCode.create({
      data: {
        target: phone,
        purpose,
        // Only the hash is persisted; the plaintext exists in memory for the
        // duration of the send below.
        codeHash: await hashOtpCode(code),
        expiresAt,
      },
    });

    await this.notifications.sendTransactionalSms(
      phone,
      this.composeMessage(code, purpose),
      `otp-${purpose.toLowerCase()}`,
      { purpose },
    );

    this.logCode(phone, purpose, code);

    return { sent: true, expiresInSeconds: this.ttlSeconds() };
  }

  /**
   * Checks a submitted code against the most recent unconsumed, unexpired code
   * for this (phone, purpose).
   *
   * Codes are purpose-scoped, so a LOGIN code cannot be spent on a password
   * reset. Only the newest code is live: requesting a new one supersedes the
   * previous rather than leaving several valid at once.
   */
  async verify(
    phone: string,
    code: string,
    purpose: OtpPurpose,
  ): Promise<OtpVerifyResult> {
    const record = await this.prisma.otpCode.findFirst({
      where: {
        target: phone,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      // Expired, already used, or never issued — all indistinguishable on
      // purpose, so the response does not leak which.
      throw new BadRequestException('Invalid or expired code');
    }

    const maxAttempts = this.maxAttempts();

    if (record.attempts >= maxAttempts) {
      // Spend the code rather than leaving it to be retried.
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });
      throw new BadRequestException('Invalid or expired code');
    }

    const matches = await verifyOtpCode(record.codeHash, code);

    if (!matches) {
      // Count the failure before responding, so five wrong guesses invalidate
      // the code even if the last one is rejected by a different branch.
      const attempts = record.attempts + 1;

      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: {
          attempts,
          // Burn the code on the attempt that exhausts the allowance.
          ...(attempts >= maxAttempts ? { consumedAt: new Date() } : {}),
        },
      });

      throw new BadRequestException('Invalid or expired code');
    }

    await this.prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    return { verified: true };
  }

  /**
   * The code is only ever written to the log in development. In any other
   * environment the plaintext code exists only in memory between generation and
   * the SMS send, and never reaches a log sink, an APM trace, or an error
   * payload.
   */
  private logCode(phone: string, purpose: OtpPurpose, code: string): void {
    if (process.env.NODE_ENV !== 'development') {
      return;
    }

    this.logger.log(`[dev] OTP for ${phone} (${purpose}): ${code}`);
  }

  private composeMessage(code: string, purpose: OtpPurpose): string {
    const minutes = Math.round(this.ttlSeconds() / 60);

    const lead =
      purpose === OtpPurpose.RESET_PASSWORD
        ? 'Use this code to reset your KinoBecho password'
        : purpose === OtpPurpose.REGISTER
          ? 'Use this code to finish signing up for KinoBecho'
          : purpose === OtpPurpose.VERIFY_PHONE
            ? 'Use this code to verify your phone number'
            : 'Use this code to sign in to KinoBecho';

    return `${lead}: ${code}. Valid for ${minutes} minutes. Do not share it with anyone.`;
  }
}
