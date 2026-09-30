import { describe, expect, it } from 'vitest';
import {
  normalizeBdPhone,
  isValidBdPhone,
  InvalidPhoneNumberError,
} from '../src/common/utils/phone.util';

describe('normalizeBdPhone', () => {
  it('accepts the local 01XXXXXXXXX form', () => {
    expect(normalizeBdPhone('01712345678')).toBe('+8801712345678');
    expect(normalizeBdPhone('01312345678')).toBe('+8801312345678');
    expect(normalizeBdPhone('01912345678')).toBe('+8801912345678');
  });

  it('accepts 8801… without a plus sign', () => {
    expect(normalizeBdPhone('8801712345678')).toBe('+8801712345678');
  });

  it('accepts the E.164 form unchanged', () => {
    expect(normalizeBdPhone('+8801712345678')).toBe('+8801712345678');
  });

  it('accepts 00 as the international prefix', () => {
    expect(normalizeBdPhone('008801712345678')).toBe('+8801712345678');
  });

  it('normalizes every accepted spelling to one identity', () => {
    const forms = [
      '01712345678',
      '8801712345678',
      '+8801712345678',
      '008801712345678',
      '017 1234 5678',
      '017-1234-5678',
      '(017) 1234-5678',
    ];

    const normalized = forms.map(normalizeBdPhone);

    // This is the property the OTP tables depend on: a code issued to one
    // spelling is found when another is used to verify.
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('+8801712345678');
  });

  it('rejects non-mobile operator prefixes', () => {
    // 010/011/012/014/015 are landline ranges, not mobile.
    expect(() => normalizeBdPhone('01012345678')).toThrow(
      InvalidPhoneNumberError,
    );
    expect(() => normalizeBdPhone('01212345678')).toThrow(
      /operator prefix/,
    );
  });

  it('rejects a number that is too short or too long', () => {
    expect(() => normalizeBdPhone('0171234567')).toThrow(
      InvalidPhoneNumberError,
    );
    expect(() => normalizeBdPhone('017123456789')).toThrow(
      InvalidPhoneNumberError,
    );
  });

  it('rejects other countries rather than guessing', () => {
    expect(() => normalizeBdPhone('+14155552671')).toThrow(
      InvalidPhoneNumberError,
    );
    expect(() => normalizeBdPhone('+919876543210')).toThrow(
      InvalidPhoneNumberError,
    );
  });

  it('rejects Bangladeshi landlines', () => {
    expect(() => normalizeBdPhone('0211234567')).toThrow(
      InvalidPhoneNumberError,
    );
  });

  it('rejects empty and non-string input', () => {
    expect(() => normalizeBdPhone('')).toThrow(InvalidPhoneNumberError);
    expect(() => normalizeBdPhone(undefined as unknown as string)).toThrow(
      InvalidPhoneNumberError,
    );
    expect(() => normalizeBdPhone(12345 as unknown as string)).toThrow(
      InvalidPhoneNumberError,
    );
  });

  it('rejects strings with stray characters', () => {
    expect(() => normalizeBdPhone('+88017123abc78')).toThrow(
      InvalidPhoneNumberError,
    );
  });
});

describe('isValidBdPhone', () => {
  it('reports validity without throwing', () => {
    expect(isValidBdPhone('01712345678')).toBe(true);
    expect(isValidBdPhone('01012345678')).toBe(false);
    expect(isValidBdPhone('nonsense')).toBe(false);
  });
});
