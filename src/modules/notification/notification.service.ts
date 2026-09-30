import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { MAIL_PROVIDER, PUSH_PROVIDER } from './notification.constants';
import { SMS_PROVIDER } from './sms.constants';
import { SmsProvider } from './interfaces/sms-provider.interface';
import { MailProvider } from './interfaces/mail-provider.interface';
import { PushProvider } from './interfaces/push-provider.interface';
import { renderTemplate, resolveSubject } from './templates/template.util';
import {
  CampaignAudience,
  CampaignStatus,
  Locale,
  NotificationChannel,
  NotificationStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { DEFAULT_LOCALE, normalizeLocale } from '../../common/i18n/locale.util';

interface PromotionRecipient {
  id: string;
  email: string | null;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject(MAIL_PROVIDER) private readonly mailProvider: MailProvider,
    @Inject(PUSH_PROVIDER) private readonly pushProvider: PushProvider,
    @Inject(SMS_PROVIDER) private readonly smsProvider: SmsProvider,
    @InjectQueue('promotion-mail') private readonly promotionQueue: Queue,
  ) {}

  async sendTransactionalEmail(
    userId: string,
    to: string,
    subject: string,
    templateKey: string,
    payload: Record<string, string | number>,
    /**
     * The language to write in. Omit it and the recipient's stored preference
     * is used, which is the normal path: a notification is triggered by an order
     * or a moderation event, not by a request that carried a `?lang=`.
     */
    locale?: Locale | null,
  ) {
    const resolved = locale ?? (await this.localeForUser(userId));

    const log = await this.prisma.notificationLog.create({
      data: {
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.QUEUED,
        userId,
        recipient: to,
        subject,
        templateKey,
        locale: resolved,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    try {
      const html = renderTemplate(
        templateKey,
        { ...payload, subject },
        resolved,
      );
      // A translated template supplies its own subject; an English one keeps
      // the caller's. Mixing a Bengali body under an English subject would read
      // as a bug to the recipient.
      const result = await this.mailProvider.sendMail(
        to,
        resolveSubject(templateKey, resolved, payload) ?? subject,
        html,
      );

      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          providerRef: result.providerRef,
        },
      });

      this.logger.log(`Transactional email sent to ${to}, logId: ${log.id}`);
      return { success: true, logId: log.id };
    } catch (err) {
      const errorMessage = (err as Error).message;
      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: NotificationStatus.FAILED,
          error: errorMessage,
        },
      });
      this.logger.error(`Transactional email failed to ${to}: ${errorMessage}`);
      throw err;
    }
  }

  /**
   * Sends an SMS and records the attempt as a `NotificationLog` row, mirroring
   * `sendTransactionalEmail`: one row per send, created QUEUED, then moved to
   * SENT or FAILED.
   *
   * `userId` is optional because an OTP may be requested for a phone that has no
   * user yet — the log is still written so delivery problems are diagnosable.
   * Throws after recording FAILED so the caller can decide what to do; OTP
   * delivery is not something to fail silently.
   */
  async sendTransactionalSms(
    to: string,
    text: string,
    templateKey: string,
    payload: Record<string, string | number> = {},
    userId?: string | null,
    locale?: Locale | null,
  ) {
    // An OTP may be requested for a phone with no user row yet, so there is no
    // stored preference to read and the default locale is correct.
    const resolved =
      locale ??
      (userId ? await this.localeForUser(userId) : DEFAULT_LOCALE);

    const log = await this.prisma.notificationLog.create({
      data: {
        channel: NotificationChannel.SMS,
        status: NotificationStatus.QUEUED,
        userId: userId ?? null,
        recipient: to,
        templateKey,
        locale: resolved,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    try {
      const result = await this.smsProvider.sendSms(to, text);

      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          providerRef: result.providerRef,
        },
      });

      this.logger.log(`Transactional SMS sent to ${to}, logId: ${log.id}`);
      return { success: true, logId: log.id };
    } catch (err) {
      const errorMessage = (err as Error).message;

      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: NotificationStatus.FAILED,
          error: errorMessage,
        },
      });

      this.logger.error(`Transactional SMS failed to ${to}: ${errorMessage}`);
      throw err;
    }
  }

  async registerDeviceToken(userId: string, token: string, platform: string) {
    const existing = await this.prisma.deviceToken.findUnique({ where: { token } });

    if (existing) {
      return this.prisma.deviceToken.update({
        where: { token },
        data: { userId, platform, isActive: true, lastUsedAt: new Date() },
      });
    }

    return this.prisma.deviceToken.create({
      data: { userId, token, platform, isActive: true },
    });
  }

  async removeDeviceToken(userId: string, token: string) {
    const deviceToken = await this.prisma.deviceToken.findUnique({ where: { token } });
    if (!deviceToken || deviceToken.userId !== userId) {
      throw new NotFoundException('Device token not found');
    }
    return this.prisma.deviceToken.delete({ where: { token } });
  }

  async sendPushToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    locale?: Locale | null,
  ) {
    const resolved = locale ?? (await this.localeForUser(userId));
    const deviceTokens = await this.prisma.deviceToken.findMany({
      where: { userId, isActive: true },
      select: { token: true, id: true },
    });

    if (deviceTokens.length === 0) {
      this.logger.warn(`No active device tokens for user ${userId}`);
      return { successCount: 0, failedCount: 0 };
    }

    const tokens = deviceTokens.map((deviceToken) => deviceToken.token);

    const result = await this.pushProvider.sendToTokens(tokens, title, body, data);

    await Promise.all(
      tokens.map((token) => {
        const isSuccess = !result.failedTokens.includes(token);
        return this.prisma.notificationLog.create({
          data: {
            channel: NotificationChannel.PUSH,
            status: isSuccess ? NotificationStatus.SENT : NotificationStatus.FAILED,
            userId,
            recipient: token,
            subject: title,
            templateKey: 'push-notification',
            locale: resolved,
            payload: { body, data } as Prisma.InputJsonValue,
            sentAt: isSuccess ? new Date() : null,
            error: isSuccess ? null : 'FCM delivery failed',
          },
        });
      }),
    );

    if (result.failedTokens.length > 0) {
      const failedTokenIds = deviceTokens
        .filter((deviceToken) => result.failedTokens.includes(deviceToken.token))
        .map((deviceToken) => deviceToken.id);

      await this.prisma.deviceToken.updateMany({
        where: { id: { in: failedTokenIds } },
        data: { isActive: false },
      });
    }

    return { successCount: result.successCount, failedCount: result.failedTokens.length };
  }

  /**
   * The language a user should be written to in.
   *
   * Read from the user row rather than a request header, because most
   * notifications are triggered by an order state change long after the request
   * that caused it. A read failure resolves to the default rather than failing
   * the send: an email in the wrong language is better than no email.
   */
  private async localeForUser(
    userId: string | null | undefined,
  ): Promise<Locale> {
    if (!userId) {
      return DEFAULT_LOCALE;
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { preferredLocale: true },
      });

      return normalizeLocale(user?.preferredLocale) ?? DEFAULT_LOCALE;
    } catch (err) {
      this.logger.warn(
        `Could not read locale for user ${userId}: ${(err as Error).message}`,
      );

      return DEFAULT_LOCALE;
    }
  }

  async resolveCampaignRecipients(
    audience: CampaignAudience,
    targetFilter?: Record<string, unknown> | null,
  ): Promise<PromotionRecipient[]> {
    const where: Prisma.UserWhereInput = {
      email: { not: null },
      deletedAt: null,
    };

    if (audience === CampaignAudience.ALL_CUSTOMERS) {
      where.role = UserRole.CUSTOMER;
    } else if (audience === CampaignAudience.ALL_VENDORS) {
      where.role = UserRole.VENDOR;
    } else if (audience === CampaignAudience.CUSTOM_SEGMENT) {
      if (targetFilter?.hasOrderedFromCategory) {
        const categorySlug = String(targetFilter.hasOrderedFromCategory);
        where.ordersAsBuyer = {
          some: {
            status: 'DELIVERED',
            items: {
              some: {
                productVariant: {
                  product: { category: { slug: categorySlug } },
                },
              },
            },
          },
        };
      }
      if (targetFilter?.role) {
        where.role = targetFilter.role as UserRole;
      }
    }

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true, email: true },
    });

    return users.map((user) => ({ id: user.id, email: user.email }));
  }

  async enqueuePromotionCampaign(campaignId: string) {
    const campaign = await this.prisma.promotionCampaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.QUEUED) {
      throw new ForbiddenException('Campaign already sent or in progress');
    }

    const recipients = await this.resolveCampaignRecipients(
      campaign.audience,
      campaign.targetFilter as Record<string, unknown> | null,
    );

    if (recipients.length === 0) {
      await this.prisma.promotionCampaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.FAILED, totalRecipients: 0 },
      });
      return { enqueued: 0, totalRecipients: 0 };
    }

    const BATCH_SIZE = 200;
    const totalBatches = Math.ceil(recipients.length / BATCH_SIZE);

    await this.prisma.promotionCampaign.update({
      where: { id: campaignId },
      data: {
        status: CampaignStatus.QUEUED,
        totalRecipients: recipients.length,
      },
    });

    for (let i = 0; i < totalBatches; i++) {
      const batch = recipients.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
      const jobId = `promo-${campaignId}-${i}`;

      const job = await this.promotionQueue.add(
        'promotion-mail-batch',
        {
          campaignId,
          recipients: batch.map((recipient) => recipient.id),
          batchIndex: i,
          isLastBatch: i === totalBatches - 1,
          totalBatches,
        },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );

      await this.prisma.queueEvent.upsert({
        where: { jobId },
        update: { status: 'queued' },
        create: {
          jobId: String(job.id ?? jobId),
          type: 'promotion-mail',
          payload: {
            campaignId,
            batchIndex: i,
            totalBatches,
            recipients: batch.length,
          } as Prisma.InputJsonValue,
          status: 'queued',
        },
      });
    }

    return { enqueued: totalBatches, totalRecipients: recipients.length };
  }
}