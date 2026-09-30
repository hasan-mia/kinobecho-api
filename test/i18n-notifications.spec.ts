import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Locale } from '@prisma/client';
import {
  registerTranslatedTemplate,
  renderTemplate,
  resolveSubject,
  resolveTemplate,
} from '../src/modules/notification/templates/template.util';
import {
  renderSmsTemplate,
  hasSmsTemplate,
} from '../src/modules/notification/templates/sms-template.util';

const payload = {
  name: 'Ayesha',
  orderNumber: 'KB-20260101-A1B2C3',
  total: '1500.00',
  currency: 'BDT',
  orderUrl: 'http://x/1',
  otp: '482913',
  expiryMinutes: 5,
};

describe('renderTemplate — locale selection', () => {
  it('renders the English template for en', () => {
    const html = renderTemplate('order-confirmation', payload, Locale.en);

    expect(html).toContain('Thank you for your order');
    expect(html).not.toContain('আপনার অর্ডার');
  });

  it('renders the Bengali template for bn', () => {
    const html = renderTemplate('order-confirmation', payload, Locale.bn);

    expect(html).toContain('আপনার অর্ডার নিশ্চিত হয়েছে');
    expect(html).not.toContain('Thank you for your order');
  });

  it('defaults to English when no locale is passed', () => {
    expect(renderTemplate('order-confirmation', payload)).toContain(
      'Thank you for your order',
    );
  });

  it('falls back to English for a template with no translation', () => {
    // A notification with no translation must still be sent, in a language the
    // recipient can read, rather than dropped.
    const html = renderTemplate('return-approved', payload, Locale.bn);

    expect(html).toContain('Your return request');
  });

  it('throws for an unknown template key in any locale', () => {
    expect(() => renderTemplate('nope', payload, Locale.bn)).toThrow(
      /Template not found/,
    );
  });

  it('substitutes the same placeholders in both languages', () => {
    const html = renderTemplate('order-confirmation', payload, Locale.bn);

    expect(html).toContain('KB-20260101-A1B2C3');
    expect(html).toContain('1500.00');
    expect(html).not.toContain('{{orderNumber}}');
  });
});

describe('renderTemplate — surrounding chrome follows the locale', () => {
  it('translates the footer', () => {
    expect(renderTemplate('otp', payload, Locale.bn)).toContain('সর্বস্বত্ব সংরক্ষিত');
    expect(renderTemplate('otp', payload, Locale.en)).toContain(
      'All rights reserved',
    );
  });

  it('never leaves an unsubstituted chrome placeholder', () => {
    for (const locale of [Locale.en, Locale.bn]) {
      const html = renderTemplate('otp', payload, locale);

      expect(html).not.toContain('{{rightsReserved}}');
      expect(html).not.toContain('{{subject}}');
      expect(html).not.toContain('{{content}}');
      expect(html).not.toContain('{{year}}');
    }
  });
});

describe('resolveSubject', () => {
  it('supplies a Bengali subject for a translated template', () => {
    // A Bengali body under an English subject reads as a bug to the recipient.
    expect(resolveSubject('order-confirmation', Locale.bn, payload)).toContain(
      'KB-20260101-A1B2C3',
    );
  });

  it('returns null so the caller keeps its own subject', () => {
    expect(resolveSubject('return-approved', Locale.bn, payload)).toBeNull();
    expect(resolveSubject('order-confirmation', Locale.en, payload)).toBeNull();
  });
});

describe('registerTranslatedTemplate', () => {
  it('adds a translation for a locale that had none', () => {
    registerTranslatedTemplate('return-approved', Locale.bn, '<p>ফেরত অনুমোদিত</p>');

    expect(renderTemplate('return-approved', payload, Locale.bn)).toContain(
      'ফেরত অনুমোদিত',
    );
  });

  it('leaves other locales on the base template', () => {
    registerTranslatedTemplate('return-approved', Locale.bn, '<p>বাংলা</p>');

    expect(renderTemplate('return-approved', payload, Locale.en)).toContain(
      'Your return request',
    );
  });
});

describe('resolveTemplate', () => {
  it('returns the base template for the default locale', () => {
    expect(resolveTemplate('otp', Locale.en)).toContain('verification code');
  });

  it('returns the translation for a supported locale', () => {
    expect(resolveTemplate('otp', Locale.bn)).toContain('যাচাইকরণ কোড');
  });
});

describe('renderSmsTemplate', () => {
  it('renders the Bengali body with substitutions', () => {
    const text = renderSmsTemplate('otp', payload, Locale.bn, 'fallback');

    expect(text).toContain('482913');
    expect(text).toContain('5');
    expect(text).not.toContain('{{otp}}');
  });

  it("falls back to the caller's text rather than dropping the message", () => {
    expect(renderSmsTemplate('otp', payload, Locale.en, 'Code: 482913')).toBe(
      'Code: 482913',
    );
  });

  it('falls back for an unknown template key', () => {
    expect(renderSmsTemplate('nope', payload, Locale.bn, 'safe text')).toBe(
      'safe text',
    );
  });

  it('reports which keys are translated', () => {
    expect(hasSmsTemplate('otp', Locale.bn)).toBe(true);
    expect(hasSmsTemplate('otp', Locale.en)).toBe(false);
  });
});
