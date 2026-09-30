import * as argon2 from 'argon2';

/**
 * Argon2id hashing for credentials and one-time codes.
 *
 * `argon2.hash` already defaults to argon2id, so this wrapper pins the type
 * explicitly and gives the OTP code a single place to call. Sharing the helper
 * with password hashing is deliberate: it means the parameters and the algorithm
 * for a 6-digit code can never drift from the ones used for a password.
 */

/** Cost for OTP hashes. Lower than passwords: codes are short-lived and single-use. */
const OTP_HASH_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Cost for passwords, unchanged from the historical argon2 defaults. */
const PASSWORD_HASH_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
};

export function hashOtpCode(code: string): Promise<string> {
  return argon2.hash(code, OTP_HASH_OPTIONS);
}

export function verifyOtpCode(hash: string, code: string): Promise<boolean> {
  return argon2.verify(hash, code);
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PASSWORD_HASH_OPTIONS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}
