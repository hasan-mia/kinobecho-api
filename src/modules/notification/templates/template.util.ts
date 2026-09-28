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
      <p>&copy; {{year}} KinoBecho. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

const TEMPLATES: Record<string, string> = {
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
  'otp': `
    <p>Hi {{name}},</p>
    <p>Your verification code is:</p>
    <h2 style="letter-spacing: 4px; text-align: center;">{{otp}}</h2>
    <p>This code expires in {{expiryMinutes}} minutes.</p>
  `,
};

export function renderTemplate(templateKey: string, payload: Record<string, string | number>): string {
  const template = TEMPLATES[templateKey];
  if (!template) {
    throw new Error(`Template not found: ${templateKey}`);
  }

  let content = template;
  for (const [key, value] of Object.entries(payload)) {
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    content = content.replace(placeholder, String(value));
  }

  let html = BASE_LAYOUT;
  html = html.replace('{{subject}}', payload.subject as string || 'KinoBecho Notification');
  html = html.replace('{{content}}', content);
  html = html.replace('{{year}}', new Date().getFullYear().toString());

  return html;
}

export function registerTemplate(key: string, template: string): void {
  TEMPLATES[key] = template;
}