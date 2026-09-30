import { Locale } from '@prisma/client';

const BASE_LAYOUT = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{subject}}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .container { background: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { text-align: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #eee; }
    .header h1 { margin: 0; color: #1a1a1a; font-size: 24px; }
    .content { margin-bottom: 24px; }
    .button { display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; }
    .footer { text-align: center; font-size: 12px; color: #888; padding-top: 16px; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>KinoBecho</h1>
    </div>
    <div class="content">
      {{content}}
    </div>
    <div class="footer">
      <p>&copy; {{year}} KinoBecho. {{rightsReserved}}</p>
    </div>
  </div>
</body>
</html>
`;

const TEMPLATES: Record<string, string> = {
  'rfq-quotation-received': `
    <p>Hello {{name}},</p>
    <p><strong>{{vendorName}}</strong> sent a quotation for your request
       "<strong>{{rfqTitle}}</strong>".</p>
    <p>Sign in to review the price, minimum quantity and lead time.</p>
  `,
  'rfq-quotation-accepted': `
    <p>Hello {{name}},</p>
    <p>Your quotation for "<strong>{{rfqTitle}}</strong>" was accepted, and order
       <strong>#{{orderNumber}}</strong> has been created at the quoted price.</p>
    <p>The buyer will receive a payment request shortly. Nothing further is needed
       from you right now.</p>
  `,
  'order-confirmation': `
    <p>Hi {{name}},</p>
    <p>Thank you for your order! Your order <strong>#{{orderNumber}}</strong> has been confirmed.</p>
    <p>Order total: <strong>{{currency}} {{total}}</strong></p>
    <p><a href="{{orderUrl}}" class="button">View Order</a></p>
    <p>We'll notify you when your order ships.</p>
  `,
  'kyc-approved': `
    <p>Hi {{name}},</p>
    <p>Great news! Your KYC documents have been <strong>approved</strong>.</p>
    <p>Your vendor account <strong>{{businessName}}</strong> is now active and ready to sell.</p>
    <p><a href="{{vendorUrl}}" class="button">Go to Dashboard</a></p>
  `,
  'kyc-rejected': `
    <p>Hi {{name}},</p>
    <p>We've reviewed your KYC documents and unfortunately they were <strong>rejected</strong>.</p>
    <p>Reason: {{reason}}</p>
    <p>Please update your documents and resubmit.</p>
    <p><a href="{{vendorUrl}}" class="button">Update Documents</a></p>
  `,
  'promo-blast': `
    <p>Hi {{name}},</p>
    <div>{{{bodyHtml}}}</div>
    <p><a href="{{ctaUrl}}" class="button">{{ctaText}}</a></p>
  `,
  'return-requested': `
    <p>Hi {{name}},</p>
    <p>Your return request <strong>#{{returnNumber}}</strong> for order <strong>#{{orderNumber}}</strong> has been received.</p>
    <p>Reason: {{reason}}</p>
    <p>You can follow its progress from your account.</p>
  `,
  'return-approved': `
    <p>Hi {{name}},</p>
    <p>Your return request <strong>#{{returnNumber}}</strong> for order <strong>#{{orderNumber}}</strong> was <strong>approved</strong>.</p>
    <p>We'll arrange pickup and notify you when your items are collected.</p>
  `,
  'return-rejected': `
    <p>Hi {{name}},</p>
    <p>Your return request <strong>#{{returnNumber}}</strong> for order <strong>#{{orderNumber}}</strong> was <strong>rejected</strong>.</p>
    <p>Reason: {{note}}</p>
    <p>If you think this is a mistake, reply to this email and we will review it again.</p>
  `,
  'return-pickup-scheduled': `
    <p>Hi {{name}},</p>
    <p>A pickup has been scheduled for your return <strong>#{{returnNumber}}</strong> on order <strong>#{{orderNumber}}</strong>.</p>
    <p>Pickup date: {{pickupDate}}</p>
  `,
  'return-received': `
    <p>Hi {{name}},</p>
    <p>We have received your returned items for <strong>#{{returnNumber}}</strong> (order <strong>#{{orderNumber}}</strong>).</p>
    <p>Your refund is now being processed.</p>
  `,
  'return-refunded': `
    <p>Hi {{name}},</p>
    <p>Your refund for return <strong>#{{returnNumber}}</strong> (order <strong>#{{orderNumber}}</strong>) has been issued.</p>
    <p>Refund amount: <strong>{{currency}} {{amount}}</strong></p>
    <p>{{paymentNote}}</p>
  `,
  'return-closed': `
    <p>Hi {{name}},</p>
    <p>Return <strong>#{{returnNumber}}</strong> for order <strong>#{{orderNumber}}</strong> is now closed.</p>
  `,
  'vendor-return-decision': `
    <p>Hi {{name}},</p>
    <p>A return request <strong>#{{returnNumber}}</strong> was filed against order <strong>#{{orderNumber}}</strong>.</p>
    <p>Reason: {{reason}}</p>
    <p>Please review and approve or reject it.</p>
  `,
  'vendor-return-approved': `
    <p>Hi {{name}},</p>
    <p>Return <strong>#{{returnNumber}}</strong> for order <strong>#{{orderNumber}}</strong> was approved.</p>
    <p>The buyer has been notified and pickup will be arranged.</p>
  `,
  'vendor-return-rejected': `
    <p>Hi {{name}},</p>
    <p>Return <strong>#{{returnNumber}}</strong> for order <strong>#{{orderNumber}}</strong> was rejected.</p>
    <p>Reason: {{note}}</p>
  `,
  'vendor-return-received': `
    <p>Hi {{name}},</p>
    <p>Returned items for <strong>#{{returnNumber}}</strong> (order <strong>#{{orderNumber}}</strong>) have been marked as received.</p>
    <p>{{restockNote}}</p>
  `,
  'vendor-return-refunded': `
    <p>Hi {{name}},</p>
    <p>A refund of <strong>{{currency}} {{amount}}</strong> was issued for return <strong>#{{returnNumber}}</strong> on order <strong>#{{orderNumber}}</strong>.</p>
    <p>{{adjustmentNote}}</p>
  `,
  'product-question': `
    <p>Hi {{name}},</p>
    <p>A buyer asked about <strong>{{productName}}</strong>:</p>
    <blockquote>{{question}}</blockquote>
    <p>Asked by {{askerName}}. Please answer from your dashboard.</p>
  `,
  'product-answer': `
    <p>Hi {{name}},</p>
    <p>Your question about <strong>{{productName}}</strong> was answered.</p>
    <blockquote>{{question}}</blockquote>
    <p><strong>{{answeredBy}} wrote:</strong></p>
    <blockquote>{{answer}}</blockquote>
  `,
  'low-stock-alert': `
    <p>Hi {{name}},</p>
    <p>Stock is running low for one of your products.</p>
    <p><strong>{{productName}}</strong> ({{sku}}) is down to <strong>{{stock}}</strong> unit(s), at or below your alert level of {{threshold}}.</p>
    <p><a href="{{productUrl}}" class="button">Update Stock</a></p>
  `,
  'otp': `
    <p>Hi {{name}},</p>
    <p>Your verification code is:</p>
    <h2 style="letter-spacing: 4px; text-align: center;">{{otp}}</h2>
    <p>This code expires in {{expiryMinutes}} minutes.</p>
  `,
};

/**
 * Bengali overrides, keyed `templateKey` then locale.
 *
 * Only keys listed here have a translation; everything else resolves to the
 * English template. That is deliberate rather than an oversight — a notification
 * with no translation must still be sent, in a language the recipient can read,
 * rather than dropped or sent with raw placeholder braces.
 */
const TRANSLATED_TEMPLATES: Partial<Record<string, Partial<Record<Locale, string>>>> = {
  'rfq-quotation-received': {
    bn: `
      <p>নমস্কার {{name}},</p>
      <p><strong>{{vendorName}}</strong> আপনার অনুরোধ "<strong>{{rfqTitle}}</strong>"-এর জন্য একটি দাম পাঠিয়েছেন।</p>
      <p>দাম, সর্বনিম্ন পরিমাণ ও ডেলিভারি সময় দেখতে সাইন ইন করুন।</p>
    `,
  },
  'rfq-quotation-accepted': {
    bn: `
      <p>নমস্কার {{name}},</p>
      <p>"<strong>{{rfqTitle}}</strong>"-এর জন্য আপনার দাম গৃহীত হয়েছে। অর্ডার
         <strong>#{{orderNumber}}</strong> তৈরি হয়েছে।</p>
      <p>শীঘ্রই ক্রেতা পেমেন্টের অনুরোধ পাবেন। এই মুহূর্তে আপনাকে আর কিছু করতে হবে না।</p>
    `,
  },
  'order-confirmation': {
    bn: `
      <p>নমস্কার {{name}},</p>
      <p>আপনার অর্ডার নিশ্চিত হয়েছে! অর্ডার <strong>#{{orderNumber}}</strong> গৃহীত হয়েছে।</p>
      <p>মোট: <strong>{{currency}} {{total}}</strong></p>
      <p><a href="{{orderUrl}}" class="button">অর্ডার দেখুন</a></p>
      <p>অর্ডার পাঠানো হলে আমরা আপনাকে জানাব।</p>
    `,
  },
  'kyc-approved': {
    bn: `
      <p>নমস্কার {{name}},</p>
      <p>আপনার KYC ডকুমেন্ট <strong>অনুমোদিত</strong> হয়েছে।</p>
      <p>আপনার ভেন্ডর অ্যাকাউন্ট <strong>{{businessName}}</strong> এখন সক্রিয়।</p>
      <p><a href="{{vendorUrl}}" class="button">ড্যাশবোর্ডে যান</a></p>
    `,
  },
  'kyc-rejected': {
    bn: `
      <p>নমস্কার {{name}},</p>
      <p>আপনার KYC ডকুমেন্ট পর্যালোচনা করা হয়েছে এবং দুঃখিতসূত্রে তা <strong>বাতিল</strong> করা হয়েছে।</p>
      <p>কারণ: {{reason}}</p>
      <p>অনুগ্রহ করে ডকুমেন্ট আপডেট করে আবার জমা দিন।</p>
      <p><a href="{{vendorUrl}}" class="button">ডকুমেন্ট আপডেট করুন</a></p>
    `,
  },
  'otp': {
    bn: `
      <p>নমস্কার {{name}},</p>
      <p>আপনার যাচাইকরণ কোড:</p>
      <h2 style="letter-spacing: 4px; text-align: center;">{{otp}}</h2>
      <p>কোডটি {{expiryMinutes}} মিনিট পরে মেয়াদ শেষ হবে।</p>
    `,
  },
  'low-stock-alert': {
    bn: `
      <p>নমস্কার {{name}},</p>
      <p>আপনার একটি পণ্যের স্টক কমে যাচ্ছে।</p>
      <p><strong>{{productName}}</strong> ({{sku}}) — মাত্র <strong>{{stock}}</strong> টি বাকি, সতর্কতার স্তর {{threshold}}।</p>
      <p><a href="{{productUrl}}" class="button">স্টক আপডেট করুন</a></p>
    `,
  },
};

/** Text pieces that are not the template body, but still need translating. */
const TRANSLATED_SUBJECTS: Partial<Record<string, Partial<Record<Locale, string>>>> = {
  'order-confirmation': {
    bn: 'অর্ডার #{{orderNumber}} নিশ্চিত হয়েছে',
  },
  'rfq-quotation-received': { bn: '{{vendorName}} আপনার অনুরোধে দাম পাঠিয়েছেন' },
  'rfq-quotation-accepted': { bn: 'আপনার দাম গৃহীত হয়েছে — অর্ডার #{{orderNumber}}' },
  'kyc-approved': { bn: 'আপনার KYC অনুমোদিত হয়েছে' },
  'kyc-rejected': { bn: 'আপনার KYC বাতিল হয়েছে' },
  otp: { bn: 'আপনার যাচাইকরণ কোড' },
  'low-stock-alert': { bn: 'স্টক কমে যাচ্ছে: {{productName}}' },
};

const CHROME: Record<Locale, { rightsReserved: string; fallbackSubject: string }> = {
  en: { rightsReserved: 'All rights reserved.', fallbackSubject: 'KinoBecho Notification' },
  bn: { rightsReserved: 'সর্বস্বত্ব সংরক্ষিত।', fallbackSubject: 'কিনোবেচো নোটিফিকেশন' },
};

/**
 * Returns the template body for a key and locale, or null when the key is
 * unknown.
 *
 * A missing Bengali translation is not an error: it resolves to the English
 * body. Returning null is reserved for an unknown key, which is a programming
 * mistake and still throws.
 */
export function resolveTemplate(templateKey: string, locale: Locale): string {
  const translated = TRANSLATED_TEMPLATES[templateKey]?.[locale];

  if (translated) {
    return translated;
  }

  const base = TEMPLATES[templateKey];

  if (!base) {
    throw new Error(`Template not found: ${templateKey}`);
  }

  return base;
}

/** The subject line for a key and locale, or null to let the caller supply one. */
export function resolveSubject(
  templateKey: string,
  locale: Locale,
  payload: Record<string, string | number>,
): string | null {
  const template = TRANSLATED_SUBJECTS[templateKey]?.[locale];

  if (!template) {
    return null;
  }

  return renderBody(template, payload);
}

export function renderTemplate(
  templateKey: string,
  payload: Record<string, string | number>,
  locale: Locale = 'en',
): string {
  const content = renderBody(resolveTemplate(templateKey, locale), payload);
  const chrome = CHROME[locale] ?? CHROME.en;
  const subject =
    resolveSubject(templateKey, locale, payload) ??
    (typeof payload.subject === 'string' && payload.subject
      ? payload.subject
      : chrome.fallbackSubject);

  let html = BASE_LAYOUT;
  html = html.replace('{{subject}}', subject);
  html = html.replace('{{content}}', content);
  html = html.replace('{{year}}', new Date().getFullYear().toString());
  html = html.replace('{{rightsReserved}}', chrome.rightsReserved);

  return html;
}

/** Substitutes `{{placeholder}}` tokens. */
function renderBody(
  template: string,
  payload: Record<string, string | number>,
): string {
  let content = template;

  for (const [key, value] of Object.entries(payload)) {
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    content = content.replace(placeholder, String(value));
  }

  return content;
}

export function registerTemplate(key: string, template: string): void {
  TEMPLATES[key] = template;
}

/** Registers or replaces a locale-specific template, used by tests and admin tooling. */
export function registerTranslatedTemplate(
  key: string,
  locale: Locale,
  template: string,
): void {
  TRANSLATED_TEMPLATES[key] = { ...TRANSLATED_TEMPLATES[key], [locale]: template };
}