import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SMS_PROVIDER } from './sms.constants';
import { TwilioSmsProvider } from './providers/twilio.sms.provider';
import { HttpSmsProvider } from './providers/http.sms.provider';

/**
 * Binds SMS_PROVIDER to the implementation named by SMS_DRIVER, mirroring how
 * MailModule selects the mail transport.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const driver = configService.get<string>('sms.driver') ?? 'http';

        if (driver === 'twilio') {
          return new TwilioSmsProvider(configService);
        }

        return new HttpSmsProvider(configService);
      },
    },
  ],
  exports: [SMS_PROVIDER],
})
export class SmsModule {}
