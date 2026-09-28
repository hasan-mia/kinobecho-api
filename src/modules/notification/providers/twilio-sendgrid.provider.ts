import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sgMail from '@sendgrid/mail';
import { MailProvider } from '../interfaces/mail-provider.interface';

@Injectable()
export class TwilioSendGridProvider implements MailProvider {
  private readonly logger = new Logger(TwilioSendGridProvider.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = configService.get<string>('mail.sendgrid.apiKey');
    if (apiKey) {
      sgMail.setApiKey(apiKey);
    }
  }

  async sendMail(to: string, subject: string, html: string): Promise<{ providerRef: string }> {
    const from = this.configService.get<string>('mail.from') as string;
    const msg = { to, from, subject, html };
    const [response] = await sgMail.send(msg);
    const messageId = response.headers['x-message-id'] || `sendgrid-${Date.now()}`;
    this.logger.log(`Email sent via SendGrid to ${to}, messageId: ${messageId}`);
    return { providerRef: messageId };
  }
}