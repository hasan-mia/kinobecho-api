import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { SocialProvider } from '@prisma/client';
import { SocialIdentity } from './social-identity.interface';

/**
 * Verifies a Google ID token and reports who it belongs to.
 *
 * Verification is delegated to `google-auth-library` rather than hand-rolled:
 * the parts that matter here (signature, `exp`, `iss`, and the audience match
 * against our own client ids) are exactly the parts that are easy to get
 * subtly wrong, and the library is already present in the tree via GCS.
 */
@Injectable()
export class GoogleAuthProvider {
  private readonly logger = new Logger(GoogleAuthProvider.name);
  private readonly clientIds: string[];
  // OAuth2Client memoises Google's signing certificates on the instance, keyed by
  // the certs' expiry. Building one per verification would re-fetch them over
  // the network on every sign-in, so a single client is kept for the provider's
  // lifetime. Constructing it is free: nothing is fetched until verifyIdToken.
  private readonly client = new OAuth2Client();

  constructor(private readonly configService: ConfigService) {
    this.clientIds =
      this.configService.get<string[]>('socialAuth.googleClientIds') ?? [];
  }

  async verify(idToken: string): Promise<SocialIdentity> {
    if (this.clientIds.length === 0) {
      throw new ServiceUnavailableException('Google sign-in is not configured');
    }

    const payload = await this.readPayload(idToken);

    // Belt and braces. `verifyIdToken` is already given the audience list and
    // throws on a mismatch, so this cannot normally fire; it is here so that
    // the guarantee does not depend on a library's internals staying as they
    // are. A token minted for a different app must never resolve to our user.
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audience.some((aud) => this.clientIds.includes(aud))) {
      this.logger.warn('Google ID token carried an audience we do not serve');
      throw new UnauthorizedException('Invalid Google token');
    }

    if (!this.isEmailVerified(payload.email_verified)) {
      // Google can issue a token for an address the account owner has never
      // confirmed. Signing such a person in — or matching them to an existing
      // local account by that address — would let anyone who can mint an
      // unverified Google address take over the matching account.
      throw new UnauthorizedException(
        'Google account email is not verified; verify it with Google and try again',
      );
    }

    return {
      provider: SocialProvider.GOOGLE,
      providerUserId: payload.sub,
      email: payload.email ?? null,
      emailVerified: true,
      name: payload.name ?? null,
    };
  }

  private async readPayload(idToken: string) {
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientIds,
      });

      const payload = ticket.getPayload();

      if (!payload?.sub) {
        throw new UnauthorizedException('Invalid Google token');
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      // The library's rejection reasons (bad signature, expiry, audience) are
      // not the caller's business, and a forged token must not be
      // distinguishable from an expired one.
      this.logger.warn(`Google ID token rejected: ${(error as Error).message}`);
      throw new UnauthorizedException('Invalid Google token');
    }
  }

  /**
   * Google sends this as a boolean, but the field is typed loosely enough that
   * the string `"true"` has been observed in the wild. Comparing loosely would
   * also accept `"false"`, so the string is matched exactly.
   */
  private isEmailVerified(value: unknown): boolean {
    return value === true || value === 'true';
  }
}
