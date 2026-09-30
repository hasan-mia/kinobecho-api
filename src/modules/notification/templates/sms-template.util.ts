import { Locale } from '@prisma/client';

/**
 * SMS bodies, keyed `templateKey` then locale.
 *
 * Kept apart from the HTML templates on purpose: an SMS has no layout, no
 * markup, and a hard character budget, so sharing the email templates would
 * mean either a 600-byte HTML wrapper on every text message or a template
 * abstraction loose enough to accept markup that a phone will render literally.
 *
 * An untranslated key falls back to the caller's own `text`, so a message is
 * never dropped or sent with unsubstituted placeholders.
 */
const SMS_TEMPLATES: Record<string, Partial<Record<Locale, string>>> = {
  otp: {
    bn: '{{otp}} হলো আপনার যাচাইকরণ কোড। {{expiryMinutes}} মিনিটে মেয়াদ শেষ।',
  },
  'order-confirmed': {
    bn: 'অর্ডার #{{orderNumber}} নিশ্চিত হয়েছে। মোট {{currency}} {{total}}।',
  },
  'order-shipped': {
    bn: 'অর্ডার #{{orderNumber}} পাঠানো হয়েছে। {{trackingUrl}}',
  },
  'return-approved': {
    bn: 'অর্ডার #{{orderNumber}}-এর রিটার্ন অনুমোদিত হয়েছে। পিকআপের সময় জানানো হবে।',
  },
  'return-refunded': {
    bn: 'অর্ডার #{{orderNumber}}-এর {{currency}} {{amount}} ফেরত দেওয়া হয়েছে।',
  },
};

export function renderSmsTemplate(
  templateKey: string,
  payload: Record<string, string | number>,
  locale: Locale,
  fallbackText: string,
): string {
  const template = SMS_TEMPLATES[templateKey]?.[locale];

  if (!template) {
    // A missing translation is not a failure: the caller's pre-composed text is
    // the English form and is still correct to send.
    return fallbackText;
  }

  let body = template;

  for (const [key, value] of Object.entries(payload)) {
    body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
  }

  return body;
}

export function hasSmsTemplate(templateKey: string, locale: Locale): boolean {
  return SMS_TEMPLATES[templateKey]?.[locale] !== undefined;
}
