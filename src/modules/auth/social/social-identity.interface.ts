export type SocialProvider = 'GOOGLE' | 'FACEBOOK';

/**
 * A provider identity, normalised across Google and Facebook.
 *
 * The orchestrator downstream reasons only about this shape, so adding a third
 * provider later means teaching one adapter to produce it rather than touching
 * the sign-in flow.
 */
export interface SocialIdentity {
  provider: SocialProvider;
  /** The provider's own immutable subject id. Never an email. */
  providerUserId: string;
  email: string | null;
  /**
   * Whether the provider asserts this address belongs to the person signing in.
   *
   * Sign-in may never key on an address the provider has not vouched for: an
   * unverified address is attacker-chosen, and using one to match an existing
   * local account would hand that account to whoever supplied it.
   */
  emailVerified: boolean;
  /** Best available display name; may be null when the provider withholds it. */
  name: string | null;
}
