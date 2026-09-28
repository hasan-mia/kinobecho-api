import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, getApps, initializeApp } from 'firebase-admin';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';
import { PushProvider } from '../interfaces/push-provider.interface';

@Injectable()
export class FcmProvider implements PushProvider, OnModuleInit {
  private readonly logger = new Logger(FcmProvider.name);
  private app: App | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const serviceAccountBase64 = this.configService.get<string>('mail.fcm.serviceAccountBase64');
    if (!serviceAccountBase64) {
      this.logger.warn('FCM_SERVICE_ACCOUNT_BASE64 not set, push notifications will not work');
      return;
    }

    try {
      const serviceAccount = JSON.parse(
        Buffer.from(serviceAccountBase64, 'base64').toString('utf-8'),
      );

      this.app = getApps()[0]
        ? (getApps()[0] as App)
        : initializeApp({
            credential: cert(serviceAccount),
            projectId:
              this.configService.get<string>('mail.fcm.projectId') ??
              serviceAccount.project_id,
          });
      this.logger.log('Firebase Admin SDK initialized');
    } catch (err) {
      this.logger.error(`Failed to initialize Firebase Admin: ${(err as Error).message}`);
    }
  }

  async sendToTokens(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ successCount: number; failedTokens: string[] }> {
    if (!this.app) {
      this.logger.error('Firebase Admin not initialized');
      return { successCount: 0, failedTokens: tokens };
    }

    if (tokens.length === 0) {
      return { successCount: 0, failedTokens: [] };
    }

    const messaging = getMessaging(this.app);
    const message: MulticastMessage = {
      tokens,
      notification: { title, body },
      data,
      android: { priority: 'high' },
      apns: { payload: { aps: { contentAvailable: true } } },
    };

    try {
      const response = await messaging.sendEachForMulticast(message);
      const failedTokens: string[] = [];

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          if (
            errorCode === 'messaging/registration-token-not-registered' ||
            errorCode === 'messaging/invalid-registration-token'
          ) {
            failedTokens.push(tokens[idx] as string);
          }
        }
      });
      this.logger.log(`FCM send: ${response.successCount} success, ${failedTokens.length} failed`);
      return { successCount: response.successCount, failedTokens };
    } catch (err) {
      this.logger.error(`FCM send failed: ${(err as Error).message}`);
      return { successCount: 0, failedTokens: tokens };
    }
  }
}