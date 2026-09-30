/**
 * Bangladeshi phone numbers.
 *
 * Every phone that reaches the OTP tables or the `User.phone` column is stored
 * E.164 (+8801XXXXXXXXX). Normalising at the boundary is what makes
 * `+8801…`, `8801…` and `01…` the same person, and it is why an OTP issued to one
 * spelling can be verified against another.
 */

/** Operator prefixes for a valid Bangladeshi mobile number. */
const VALID_MOBILE_PREFIXES = ['13', '14', '15', '16', '17', '18', '19'];

/** Local format: 01XXXXXXXXX — 11 digits total. */
const LOCAL_MOBILE = /^01[3-9]\d{8}$/;

/** International without the plus: 8801XXXXXXXXX. */
const INTL_MOBILE = /^8801[3-9]\d{8}$/;

/** E.164: +8801XXXXXXXXX. */
const E164_MOBILE = /^\+8801[3-9]\d{8}$/;

/**
 * Anything the regexes above cannot handle: a landline, a malformed number, or
 * another country entirely. Rejected rather than guessed at, because a silently
 * mangled number means a code that never arrives.
 */
export class InvalidPhoneNumberError extends Error {
  constructor(message = 'Invalid Bangladeshi phone number') {
    super(message);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Normalises a BD phone number to E.164.
 *
 * @throws {InvalidPhoneNumberError} when the input is not a BD mobile number.
 */
export function normalizeBdPhone(input: string): string {
  if (typeof input !== 'string') {
    throw new InvalidPhoneNumberError();
  }

  // Tolerate the separators people actually type: spaces, dashes, parentheses.
  // A leading 00 international prefix is accepted as well.
  const cleaned = input.replace(/[\s\-()]/g, '');

  if (cleaned.startsWith('00')) {
    const stripped = `+${cleaned.slice(2)}`;
    if (E164_MOBILE.test(stripped)) {
      return stripped;
    }
    throw new InvalidPhoneNumberError();
  }

  if (E164_MOBILE.test(cleaned)) {
    return cleaned;
  }

  if (INTL_MOBILE.test(cleaned)) {
    return `+${cleaned}`;
  }

  if (LOCAL_MOBILE.test(cleaned)) {
    return `+880${cleaned.slice(1)}`;
  }

  // A 01… number with a non-mobile operator prefix (012, 016 is valid, 010 is
  // not) is the most common real-world typo, so the reason is explicit.
  if (/^01\d{9}$/.test(cleaned)) {
    const prefix = cleaned.slice(0, 3);
    throw new InvalidPhoneNumberError(
      `Not a valid Bangladeshi mobile operator prefix: ${prefix}`,
    );
  }

  throw new InvalidPhoneNumberError();
}

/** True when the input normalises; useful for DTO-level validation. */
export function isValidBdPhone(input: string): boolean {
  try {
    normalizeBdPhone(input);
    return true;
  } catch {
    return false;
  }
}

export { VALID_MOBILE_PREFIXES };
