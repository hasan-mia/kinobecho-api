import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MAIL_PROVIDER } from './notification.constants';
import { SmtpProvider } from './providers/smtp.provider';
import { TwilioSendGridProvider } from './providers/twilio-sendgrid.provider';
import { FcmProvider } from './providers/fcm.provider';
import { PUSH_PROVIDER } from './notification.constants';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const driver = configService.get<string>('mail.driver') ?? 'smtp';
        if (driver === 'twilio') {
          return new TwilioSendGridProvider(configService);
        }
        return new SmtpProvider(configService);
      },
    },
    {
      provide: PUSH_PROVIDER,
      useClass: FcmProvider,
    },
  ],
  exports: [MAIL_PROVIDER, PUSH_PROVIDER],
})
export class MailModule {}