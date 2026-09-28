import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MailProvider } from '../interfaces/mail-provider.interface';

@Injectable()
export class SmtpProvider implements MailProvider {
  private readonly logger = new Logger(SmtpProvider.name);
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: configService.get<string>('mail.smtp.host'),
      port: configService.get<number>('mail.smtp.port'),
      secure: configService.get<boolean>('mail.smtp.secure'),
      auth: {
        user: configService.get<string>('mail.smtp.user'),
        pass: configService.get<string>('mail.smtp.pass'),
      },
    });
  }

  async sendMail(to: string, subject: string, html: string): Promise<{ providerRef: string }> {
    const from = this.configService.get<string>('mail.from') as string;
    const info = await this.transporter.sendMail({ from, to, subject, html });
    this.logger.log(`Email sent to ${to}, messageId: ${info.messageId}`);
    return { providerRef: info.messageId };
  }
}