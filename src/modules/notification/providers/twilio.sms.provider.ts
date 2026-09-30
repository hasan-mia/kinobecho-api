import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio from 'twilio';
import { SmsProvider } from '../interfaces/sms-provider.interface';

@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly client: ReturnType<typeof twilio>;

  constructor(private readonly configService: ConfigService) {
    const accountSid = this.configService.get<string>('sms.twilio.accountSid');
    const authToken = this.configService.get<string>('sms.twilio.authToken');

    if (!accountSid || !authToken) {
      throw new Error(
        'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required when SMS_DRIVER=twilio',
      );
    }

    this.client = twilio(accountSid, authToken);
  }

  async sendSms(to: string, text: string): Promise<{ providerRef: string }> {
    const from = this.configService.get<string>('sms.twilio.from');

    if (!from) {
      throw new Error('TWILIO_SMS_FROM is required when SMS_DRIVER=twilio');
    }

    const message = await this.client.messages.create({ to, from, body: text });

    this.logger.log(`SMS sent via Twilio to ${to}, sid: ${message.sid}`);

    return { providerRef: message.sid };
  }
}
