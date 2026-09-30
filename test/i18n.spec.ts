import { describe, expect, it } from 'vitest';
import { Locale } from '@prisma/client';
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  parseAcceptLanguage,
  resolveLocale,
} from '../src/common/i18n/locale.util';
import { applyTranslation } from '../src/common/i18n/translation.util';

describe('normalizeLocale', () => {
  it('accepts a supported tag', () => {
    expect(normalizeLocale('bn')).toBe(Locale.bn);
    expect(normalizeLocale('en')).toBe(Locale.en);
  });

  it('takes the primary subtag off a regional variant', () => {
    // bn-BD and bn-IN are not different translations this store carries.
    expect(normalizeLocale('bn-BD')).toBe(Locale.bn);
    expect(normalizeLocale('en-GB')).toBe(Locale.en);
  });

  it('is case and separator insensitive', () => {
    expect(normalizeLocale('BN')).toBe(Locale.bn);
    expect(normalizeLocale('bn_BD')).toBe(Locale.bn);
    expect(normalizeLocale('  En-US  ')).toBe(Locale.en);
  });

  it('returns null for an unsupported language rather than defaulting', () => {
    // Silently defaulting here would render content the caller cannot read
    // while appearing to honour their request.
    expect(normalizeLocale('fr')).toBeNull();
    expect(normalizeLocale('bengali')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(normalizeLocale('')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });
});

describe('parseAcceptLanguage', () => {
  it('picks the single supported language', () => {
    expect(parseAcceptLanguage('bn')).toBe(Locale.bn);
  });

  it('honours quality values over header order', () => {
    // A browser sending this wants Bengali far more than French; picking by
    // position would answer in a language the user ranked last that we carry.
    expect(parseAcceptLanguage('fr;q=0.9, bn;q=0.8')).toBe(Locale.bn);
  });

  it('skips a language explicitly refused with q=0', () => {
    expect(parseAcceptLanguage('en;q=0, bn;q=0.5')).toBe(Locale.bn);
  });

  it('skips unsupported languages and finds the supported one', () => {
    expect(parseAcceptLanguage('fr, de, bn')).toBe(Locale.bn);
  });

  it('resolves a regional tag to its base', () => {
    expect(parseAcceptLanguage('bn-BD,bn;q=0.9')).toBe(Locale.bn);
  });

  it('returns null when nothing is supported', () => {
    expect(parseAcceptLanguage('fr, de, es')).toBeNull();
    expect(parseAcceptLanguage('')).toBeNull();
    expect(parseAcceptLanguage(undefined)).toBeNull();
  });

  it('keeps the client stated order for equal weights', () => {
    expect(parseAcceptLanguage('en, bn')).toBe(Locale.en);
    expect(parseAcceptLanguage('bn, en')).toBe(Locale.bn);
  });
});

describe('resolveLocale', () => {
  it('prefers an explicit ?lang= over the header', () => {
    // A query parameter is a deliberate choice; a header is whatever the
    // browser or a proxy decided.
    expect(resolveLocale('bn', 'en-US,en;q=0.9')).toBe(Locale.bn);
  });

  it('falls back to the header when there is no query parameter', () => {
    expect(resolveLocale(undefined, 'bn-BD,bn;q=0.9')).toBe(Locale.bn);
  });

  it('falls back to English when neither is usable', () => {
    expect(resolveLocale(undefined, undefined)).toBe('en');
    expect(resolveLocale('fr', 'de')).toBe('en');
  });

  it('ignores an unsupported ?lang= rather than honouring it', () => {
    // Answering 'en' to ?lang=fr is correct: it is the only thing we can
    // render, and echoing an unrenderable locale would be a lie.
    expect(resolveLocale('fr', 'bn')).toBe(Locale.bn);
    expect(resolveLocale('fr', undefined)).toBe(DEFAULT_LOCALE);
  });

  it('ignores a non-string query value', () => {
    expect(resolveLocale(['bn', 'en'], undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ lang: 'bn' }, undefined)).toBe(DEFAULT_LOCALE);
  });

  it('defaults to en', () => {
    expect(DEFAULT_LOCALE).toBe(Locale.en);
  });
});

describe('applyTranslation — fallback to English', () => {
  const product = {
    id: 'p1',
    name: 'Widget',
    description: 'A widget',
    slug: 'widget',
  };

  const bn = { locale: Locale.bn, name: 'উইজেট', description: 'একটি উইজেট' };

  it('uses the base fields when no translation exists', () => {
    expect(applyTranslation(product, [], Locale.bn)).toEqual(product);
  });

  it('uses the base fields when translations are undefined', () => {
    expect(applyTranslation(product, undefined, Locale.bn)).toEqual(product);
  });

  it('uses the base fields for a locale it does not carry', () => {
    // The critical case: a Bengali shopper looking at a product nobody has
    // translated must see the English name, not an empty one.
    const onlyEnglish: Array<{ locale: Locale; name: string }> = [];

    expect(applyTranslation(product, onlyEnglish, Locale.bn).name).toBe('Widget');
  });

  it('applies the translation when the locale matches', () => {
    expect(applyTranslation(product, [bn], Locale.bn)).toEqual({
      ...product,
      name: 'উইজেট',
      description: 'একটি উইজেট',
    });
  });

  it('ignores a translation for a different locale', () => {
    expect(applyTranslation(product, [bn], Locale.en)).toEqual(product);
  });

  it('skips the lookup entirely for the base locale', () => {
    // English is the base language, so its translation *is* the base columns.
    // Reading it from the table would be a redundant query that could disagree
    // with them.
    const conflicting = { locale: Locale.en, name: 'Should never be used' };

    expect(applyTranslation(product, [conflicting], Locale.en).name).toBe('Widget');
  });

  it('keeps the base description when the translation omits it', () => {
    const partial = { locale: Locale.bn, name: 'উইজেট', description: null };

    // A partial override must not erase content the translator did not touch.
    expect(applyTranslation(product, [partial], Locale.bn)).toEqual({
      ...product,
      name: 'উইজেট',
    });
  });

  it('leaves slug untouched', () => {
    // Slugs are language-independent so a shared link resolves everywhere.
    expect(applyTranslation(product, [bn], Locale.bn).slug).toBe('widget');
  });

  it('leaves every other field alone', () => {
    const result = applyTranslation(product, [bn], Locale.bn);

    expect(result.id).toBe('p1');
    expect(Object.keys(result).sort()).toEqual(
      ['description', 'id', 'name', 'slug'].sort(),
    );
  });

  it('does not mutate the input', () => {
    const input = { ...product };

    applyTranslation(input, [bn], Locale.bn);

    expect(input.name).toBe('Widget');
  });

  it('works for an entity with no description field', () => {
    const brand = { id: 'b1', name: 'Samsung' };

    expect(applyTranslation(brand, [{ locale: Locale.bn, name: 'স্যামসাং' }], Locale.bn)).toEqual({
      ...brand,
      name: 'স্যামসাং',
    });
  });

  it('prefers a translation whose name is present over one that is not', () => {
    // First match wins: the query orders deterministically, so a duplicate
    // locale in the payload cannot make resolution order-dependent.
    const rows = [
      { locale: Locale.bn, name: 'প্রথম' },
      { locale: Locale.bn, name: 'দ্বিতীয়' },
    ];

    expect(applyTranslation(product, rows, Locale.bn).name).toBe('প্রথম');
  });
});
