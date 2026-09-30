import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SmsProvider } from '../interfaces/sms-provider.interface';
import { DEFAULT_SMS_HTTP_TEMPLATE } from '../sms.constants';

@Injectable()
export class HttpSmsProvider implements SmsProvider {
  private readonly logger = new Logger(HttpSmsProvider.name);

  constructor(private readonly configService: ConfigService) {}

  async sendSms(to: string, text: string): Promise<{ providerRef: string }> {
    const url = this.configService.get<string>('sms.http.url');

    if (!url) {
      throw new Error('SMS_HTTP_URL is required when SMS_DRIVER=http');
    }

    const apiKey = this.configService.get<string>('sms.http.apiKey') ?? '';
    const senderId = this.configService.get<string>('sms.http.senderId') ?? '';

    const body = this.buildBody(to, text, apiKey, senderId);

    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        // Sent as a header as well so gateways that authenticate that way work
        // without needing a template change.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: 10_000,
    });

    const providerRef =
      this.extractProviderRef(response.data) ?? `http-sms-${Date.now()}`;

    this.logger.log(`SMS sent via HTTP gateway to ${to}, ref: ${providerRef}`);

    return { providerRef };
  }

  /**
   * Renders the configured template, substituting the four supported
   * placeholders. The template is parsed once per send from either env or the
   * default constant, and a non-object or unparseable value falls back rather
   * than throwing — a misconfigured template should not take OTP delivery down.
   */
  private buildBody(
    to: string,
    text: string,
    apiKey: string,
    senderId: string,
  ): Record<string, unknown> {
    const raw =
      this.configService.get<string>('sms.http.template') ??
      JSON.stringify(DEFAULT_SMS_HTTP_TEMPLATE);

    let template: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      template =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { ...DEFAULT_SMS_HTTP_TEMPLATE };
    } catch {
      this.logger.warn(
        'SMS_HTTP_TEMPLATE is not valid JSON; falling back to the default body',
      );
      template = { ...DEFAULT_SMS_HTTP_TEMPLATE };
    }

    const substitutions: Record<string, string> = {
      '{to}': to,
      '{text}': text,
      '{api_key}': apiKey,
      '{sender_id}': senderId,
    };

    const render = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value.replace(
          /\{(to|text|api_key|sender_id)\}/g,
          (match) => substitutions[match] ?? match,
        );
      }
      if (Array.isArray(value)) {
        return value.map(render);
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            render(v),
          ]),
        );
      }
      return value;
    };

    return render(template) as Record<string, unknown>;
  }

  /**
   * Bangladeshi gateways name their message id inconsistently, so a short list of
   * known keys is tried before falling back to a synthetic reference. The
   * response body is only used for this; the full payload is kept by the caller
   * in the `NotificationLog`.
   */
  private extractProviderRef(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') {
      return undefined;
    }

    const record = data as Record<string, unknown>;

    for (const key of ['message_id', 'messageId', 'id', 'ref', 'request_id']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    return undefined;
  }
}
