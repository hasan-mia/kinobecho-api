import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SocialProvider } from '@prisma/client';
import { SocialIdentity } from './social-identity.interface';

/** Pinned so a Graph API release cannot change what these calls return. */
const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
/** A hung Graph call must not hold an auth request open indefinitely. */
const GRAPH_TIMEOUT_MS = 5000;

interface DebugTokenResponse {
  data?: {
    app_id?: string;
    is_valid?: boolean;
    user_id?: string;
  };
}

interface GraphProfile {
  id?: string;
  name?: string;
  email?: string;
}

/**
 * Verifies a Facebook user access token via the Graph API.
 *
 * Facebook has no local JWT to check, so validity comes from the provider:
 * `debug_token` is called with the app secret (never trust a client-supplied
 * "is this valid" answer), and its `app_id` is compared to ours. That last
 * comparison is the whole point — without it, a user token issued for any
 * other app on Facebook would be accepted here and would resolve to whichever
 * local account carries the same email.
 */
@Injectable()
export class FacebookAuthProvider {
  private readonly logger = new Logger(FacebookAuthProvider.name);
  private readonly appId: string | undefined;
  private readonly appSecret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.appId = this.configService.get<string>('socialAuth.facebookAppId');
    this.appSecret = this.configService.get<string>('socialAuth.facebookAppSecret');
  }

  async verify(accessToken: string): Promise<SocialIdentity> {
    if (!this.appId || !this.appSecret) {
      throw new ServiceUnavailableException('Facebook sign-in is not configured');
    }

    const debug = await this.debugToken(accessToken);
    const profile = await this.fetchProfile(accessToken);

    return {
      provider: SocialProvider.FACEBOOK,
      // debug_token is authoritative for the subject id; /me is a second call
      // that must agree with it. A mismatch means the token changed underneath
      // us, so neither number is trustworthy.
      providerUserId: profile.id ?? debug.data?.user_id ?? '',
      email: profile.email ?? null,
      // Facebook exposes no `email_verified` field: it returns `email` only for
      // an address it has itself verified on the account. The provider's
      // withholding of the field is the signal, so a present address is taken
      // as asserted and an absent one is reported as unverified rather than
      // guessed at.
      emailVerified: Boolean(profile.email),
      name: profile.name ?? null,
    };
  }

  private async debugToken(accessToken: string) {
    const response = await this.guarded(() => this.call<DebugTokenResponse>('debug_token', {
      input_token: accessToken,
      // App secret proof. Sent in the query string because that is the form
      // Graph documents for this endpoint; the request never leaves TLS to
      // Facebook, and the secret is not logged anywhere in this module.
      access_token: `${this.appId}|${this.appSecret}`,
    }));

    const data = response?.data;

    if (!data?.is_valid) {
      this.logger.warn('Facebook access token reported invalid');
      throw new UnauthorizedException('Invalid Facebook token');
    }

    if (data.app_id !== this.appId) {
      // A valid Facebook token, just not one minted for this application.
      this.logger.warn('Facebook access token was issued for a different app');
      throw new UnauthorizedException('Invalid Facebook token');
    }

    return response;
  }

  private async fetchProfile(accessToken: string): Promise<GraphProfile> {
    return this.guarded(() =>
      this.call<GraphProfile>('me', {
        fields: 'id,name,email',
        access_token: accessToken,
      }),
    );
  }

  /**
   * Collapses every way a Graph call can fail into one opaque rejection.
   *
   * Both provider calls go through here so that a network fault or a Graph error
   * body becomes a 401 rather than escaping as a raw `Error` and surfacing as a
   * 500. `UnauthorizedException` passes through untouched so the specific
   * rejections above keep their own reasons.
   */
  private async guarded<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logger.warn(`Facebook request failed: ${(error as Error).message}`);
      throw new UnauthorizedException('Invalid Facebook token');
    }
  }

  private async call<T>(path: string, params: Record<string, string>): Promise<T> {
    try {
      const response = await axios.get<T>(`${GRAPH_BASE}/${path}`, {
        params,
        timeout: GRAPH_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      });

      // Graph reports its own errors with HTTP 200 and an `errors` body, so a
      // 2xx alone is not proof the call succeeded.
      const body = response.data as { errors?: { message?: string }[] } & T;
      if (body?.errors?.length) {
        throw new Error(body.errors[0]?.message ?? 'Graph API error');
      }

      return body as T;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        throw new Error(error.response?.status === 400 ? 'invalid_token' : 'network');
      }

      throw error;
    }
  }
}
