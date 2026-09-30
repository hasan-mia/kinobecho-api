import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SocialProvider } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { GoogleAuthProvider } from '../src/modules/auth/social/google-auth.provider';
import { FacebookAuthProvider } from '../src/modules/auth/social/facebook-auth.provider';

const { verifyIdToken, getMock, isAxiosErrorMock, oauth2ClientConstructions } =
  vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  // Counts constructor calls, so "reuses one client" is asserted rather than
  // assumed: the library caches signing certs on the instance.
  oauth2ClientConstructions: [] as unknown[],
  getMock: vi.fn(),
  isAxiosErrorMock: vi.fn((e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError)),
}));

vi.mock('google-auth-library', () => ({
  // A `function`, not an arrow: the provider does `new OAuth2Client()`, and an
  // arrow is not constructible.
  OAuth2Client: vi.fn().mockImplementation(function OAuth2Client() {
    oauth2ClientConstructions.push(1);
    return { verifyIdToken };
  }),
}));

vi.mock('axios', () => ({
  default: { get: getMock, isAxiosError: isAxiosErrorMock },
}));

const config = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

/** An audience that is ours, used by fixtures that are not testing audience matching. */
const OURS = 'web.apps.googleusercontent.com';

const googleConfig = config({ 'socialAuth.googleClientIds': ['web.apps.googleusercontent.com', 'android-client'] });

/** A ticket shaped the way `google-auth-library` returns one. */
const ticket = (payload: Record<string, unknown> | null) => ({
  getPayload: () => payload,
});

describe('GoogleAuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A plain array is not touched by clearAllMocks, so reset it explicitly.
    oauth2ClientConstructions.length = 0;
  });

  const verify = async (payload: Record<string, unknown> | null, idToken = 'tok') => {
    verifyIdToken.mockResolvedValue(ticket(payload));
    return new GoogleAuthProvider(googleConfig).verify(idToken);
  };

  it('returns the identity for a valid verified token', async () => {
    const identity = await verify({
      sub: 'g-1',
      email: 'a@b.com',
      email_verified: true,
      name: 'A',
      aud: 'web.apps.googleusercontent.com',
    });

    expect(identity).toEqual({
      provider: SocialProvider.GOOGLE,
      providerUserId: 'g-1',
      email: 'a@b.com',
      emailVerified: true,
      name: 'A',
    });
  });

  it('verifies against every configured client id', async () => {
    await verify({ sub: 'g-1', email: 'a@b.com', email_verified: true, aud: 'android-client' });

    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'tok',
      audience: ['web.apps.googleusercontent.com', 'android-client'],
    });
  });

  it('accepts the string "true" for email_verified', async () => {
    // Google has been observed to send the field as a string; a strict
    // `=== true` would reject a legitimate user.
    const identity = await verify({ sub: 'g-1', email: 'a@b.com', email_verified: 'true', aud: OURS });

    expect(identity.emailVerified).toBe(true);
  });

  it('rejects an unverified email', async () => {
    await expect(
      verify({ sub: 'g-1', email: 'a@b.com', email_verified: false, aud: OURS }),
    ).rejects.toThrow(/not verified/);
  });

  it('rejects a missing email_verified claim entirely', async () => {
    await expect(verify({ sub: 'g-1', email: 'a@b.com', aud: OURS })).rejects.toThrow(/not verified/);
  });

  it('does not treat the string "false" as verified', async () => {
    // A loose `==` comparison here would wave through an unverified address.
    await expect(
      verify({ sub: 'g-1', email: 'a@b.com', email_verified: 'false', aud: OURS }),
    ).rejects.toThrow(/not verified/);
  });

  it('rejects a token minted for another app', async () => {
    await expect(
      verify({ sub: 'g-1', email: 'a@b.com', email_verified: true, aud: 'someone-elses-app' }),
    ).rejects.toThrow(/Invalid Google token/);
  });

  it('rejects when the audience claim is missing', async () => {
    await expect(verify({ sub: 'g-1', email: 'a@b.com', email_verified: true })).rejects.toThrow(
      /Invalid Google token/,
    );
  });

  it('accepts an array audience that includes one of ours', async () => {
    const identity = await verify({
      sub: 'g-1',
      email: 'a@b.com',
      email_verified: true,
      aud: ['other', 'android-client'],
    });

    expect(identity.providerUserId).toBe('g-1');
  });

  it('rejects a payload with no subject', async () => {
    await expect(verify({ email: 'a@b.com', email_verified: true, aud: OURS })).rejects.toThrow(
      /Invalid Google token/,
    );
  });

  it('rejects a null payload', async () => {
    await expect(verify(null)).rejects.toThrow(/Invalid Google token/);
  });

  it('does not leak the library rejection reason', async () => {
    verifyIdToken.mockRejectedValue(new Error('Invalid token signature: sha256'));

    await expect(new GoogleAuthProvider(googleConfig).verify('tok')).rejects.toThrow(
      /^Invalid Google token$/,
    );
  });

  it('reuses one client across calls instead of re-fetching Google certs', async () => {
    // OAuth2Client memoises Google's signing certs on the instance. A client per
    // call would re-fetch them over the network on every sign-in.
    const provider = new GoogleAuthProvider(googleConfig);

    verifyIdToken.mockResolvedValue(ticket({ sub: 'g-1', email: 'a@b.com', email_verified: true, aud: OURS }));
    await provider.verify('a');
    await provider.verify('b');
    await provider.verify('c');

    expect(oauth2ClientConstructions).toHaveLength(1);
  });

  it('reports an unconfigured provider rather than verifying blindly', async () => {
    const provider = new GoogleAuthProvider(config({ 'socialAuth.googleClientIds': [] }));

    await expect(provider.verify('tok')).rejects.toThrow(/not configured/);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('tolerates the config key being absent', async () => {
    const provider = new GoogleAuthProvider(config({}));

    await expect(provider.verify('tok')).rejects.toThrow(/not configured/);
  });
});

describe('FacebookAuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockImplementation(async (url: string) => {
      if (url.includes('debug_token')) {
        return { data: { data: { app_id: 'app-1', is_valid: true, user_id: 'fb-1' } } };
      }
      return { data: { id: 'fb-1', name: 'A', email: 'a@b.com' } };
    });
  });

  const provider = (over: Record<string, unknown> = {}) =>
    new FacebookAuthProvider(
      config({ 'socialAuth.facebookAppId': 'app-1', 'socialAuth.facebookAppSecret': 'sec', ...over }),
    );

  const verify = () => provider().verify('tok');

  it('returns the identity for a valid token', async () => {
    await expect(verify()).resolves.toEqual({
      provider: SocialProvider.FACEBOOK,
      providerUserId: 'fb-1',
      email: 'a@b.com',
      emailVerified: true,
      name: 'A',
    });
  });

  it('rejects a token issued for a different app', async () => {
    // The check that makes this endpoint safe: without it, a user token minted
    // for any other Facebook app would be accepted here.
    getMock.mockImplementation(async (url: string) =>
      url.includes('debug_token')
        ? { data: { data: { app_id: 'other-app', is_valid: true, user_id: 'fb-1' } } }
        : { data: { id: 'fb-1', name: 'A', email: 'a@b.com' } },
    );

    await expect(verify()).rejects.toThrow(/Invalid Facebook token/);
  });

  it('rejects a token the provider reports invalid', async () => {
    getMock.mockImplementation(async () => ({ data: { data: { app_id: 'app-1', is_valid: false } } }));

    await expect(verify()).rejects.toThrow(/Invalid Facebook token/);
  });

  it('rejects when debug_token returns nothing usable', async () => {
    getMock.mockImplementation(async () => ({ data: { data: {} } }));

    await expect(verify()).rejects.toThrow(/Invalid Facebook token/);
  });

  it('sends the app secret as the debug_token proof', async () => {
    await verify();

    const [url, opts] = getMock.mock.calls[0] ?? [];
    expect(url).toContain('debug_token');
    expect(opts?.params).toMatchObject({ input_token: 'tok', access_token: 'app-1|sec' });
  });

  it('requests only the fields it needs', async () => {
    await verify();

    const [url, opts] = getMock.mock.calls[1] ?? [];
    expect(url).toContain('/me');
    expect(opts?.params).toMatchObject({ fields: 'id,name,email' });
  });

  it('pins the Graph API version', async () => {
    await verify();

    for (const [url] of getMock.mock.calls as Array<[string]>) {
      expect(url).toMatch(/\/v\d+\.\d+\//);
    }
  });

  it('bounds how long a Graph call may hang', async () => {
    await verify();

    for (const opts of (getMock.mock.calls as Array<[string, { timeout: number }]>)
      .map(([, o]) => o)) {
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThanOrEqual(10_000);
    }
  });

  it('reports no email as unverified rather than assuming it', async () => {
    getMock.mockImplementation(async (url: string) =>
      url.includes('debug_token')
        ? { data: { data: { app_id: 'app-1', is_valid: true, user_id: 'fb-1' } } }
        : { data: { id: 'fb-1', name: 'A' } },
    );

    const identity = await verify();

    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it('treats a Graph error body as a failure even on HTTP 200', async () => {
    // Graph reports its own errors with a 2xx status; trusting the status code
    // alone would authenticate a token that was never valid.
    getMock.mockImplementation(async (url: string) =>
      url.includes('debug_token')
        ? { data: { app_id: 'app-1', is_valid: true, user_id: 'fb-1' } }
        : { data: { errors: [{ message: 'Invalid OAuth access token' }] } },
    );

    await expect(verify()).rejects.toThrow(/Invalid Facebook token/);
  });

  it('rejects when the network fails', async () => {
    getMock.mockImplementation(async () => {
      const err = Object.assign(new Error('timeout'), { isAxiosError: true });
      throw err;
    });

    await expect(verify()).rejects.toThrow(/Invalid Facebook token/);
  });

  it('reports an unconfigured provider', async () => {
    await expect(provider({ 'socialAuth.facebookAppSecret': '' }).verify('tok')).rejects.toThrow(
      /not configured/,
    );
    expect(getMock).not.toHaveBeenCalled();
  });

  it('reports an unconfigured provider when the app id is missing', async () => {
    await expect(provider({ 'socialAuth.facebookAppId': undefined }).verify('tok')).rejects.toThrow(
      /not configured/,
    );
  });

  it('falls back to the debug_token subject when /me omits the id', async () => {
    getMock.mockImplementation(async (url: string) =>
      url.includes('debug_token')
        ? { data: { data: { app_id: 'app-1', is_valid: true, user_id: 'fb-debug' } } }
        : { data: { name: 'A', email: 'a@b.com' } },
    );

    const identity = await verify();

    expect(identity.providerUserId).toBe('fb-debug');
  });
});
