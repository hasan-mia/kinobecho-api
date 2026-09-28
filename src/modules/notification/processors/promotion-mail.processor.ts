import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { MAIL_PROVIDER } from '../notification.constants';
import { MailProvider } from '../interfaces/mail-provider.interface';
import { Inject } from '@nestjs/common';
import { NotificationChannel, NotificationStatus, CampaignStatus } from '@prisma/client';
import { renderTemplate } from '../templates/template.util';
import { isPermanentRecipientError } from '../errors/permanent-recipient.error';

interface PromotionMailJobData {
  campaignId: string;
  recipients: string[];
  batchIndex: number;
  isLastBatch: boolean;
  totalBatches: number;
}

export type { PromotionMailJobData };

@Processor('promotion-mail', { concurrency: 5 })
@Injectable()
export class PromotionMailProcessor extends WorkerHost {
  private readonly logger = new Logger(PromotionMailProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_PROVIDER) private readonly mailProvider: MailProvider,
  ) {
    super();
  }

  async process(job: Job<PromotionMailJobData>): Promise<void> {
    const { campaignId, recipients, batchIndex, totalBatches } = job.data;

    this.logger.log(`Processing promotion mail batch ${batchIndex + 1}/${totalBatches} for campaign ${campaignId} (${recipients.length} recipients)`);

    const campaign = await this.prisma.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, subject: true, bodyHtml: true, status: true, totalRecipients: true, sentCount: true, failedCount: true },
    });

    if (!campaign) {
      this.logger.error(`Campaign ${campaignId} not found`);
      return;
    }

    if (campaign.status === CampaignStatus.FAILED || campaign.status === CampaignStatus.COMPLETED) {
      this.logger.warn(`Campaign ${campaignId} already finished with status ${campaign.status}, skipping batch`);
      return;
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: recipients }, deletedAt: null, email: { not: null } },
      select: { id: true, email: true, name: true },
    });

    let batchSent = 0;
    let batchFailed = 0;

    for (const user of users) {
      const log = await this.prisma.notificationLog.create({
        data: {
          channel: NotificationChannel.EMAIL,
          status: NotificationStatus.QUEUED,
          userId: user.id,
          recipient: user.email!,
          subject: campaign.subject,
          templateKey: 'promo-blast',
          payload: { campaignId } as any,
          campaignId,
        },
      });

      try {
        const html = renderTemplate('promo-blast', {
          name: user.name || 'Customer',
          bodyHtml: campaign.bodyHtml,
          ctaUrl: 'https://kinobecho.com/promotions',
          ctaText: 'Shop Now',
          subject: campaign.subject,
        });

        const result = await this.mailProvider.sendMail(user.email!, campaign.subject, html);

        await this.prisma.notificationLog.update({
          where: { id: log.id },
          data: {
            status: NotificationStatus.SENT,
            sentAt: new Date(),
            providerRef: result.providerRef,
          },
        });

        batchSent++;
      } catch (err) {
        const errorMessage = (err as Error).message;
        const isPermanent = this.isPermanentError(err);

        await this.prisma.notificationLog.update({
          where: { id: log.id },
          data: {
            status: NotificationStatus.FAILED,
            error: errorMessage,
          },
        });

        batchFailed++;

        if (isPermanent) {
          this.logger.warn(`Permanent failure for ${user.email}: ${errorMessage}`);
        } else {
          throw err;
        }
      }
    }

    await this.prisma.promotionCampaign.update({
      where: { id: campaignId },
      data: {
        sentCount: { increment: batchSent },
        failedCount: { increment: batchFailed },
        status: CampaignStatus.SENDING,
      },
    });

    await this.finalizeCampaign(campaignId, campaign.totalRecipients);

    this.logger.log(`Batch ${batchIndex + 1} completed: ${batchSent} sent, ${batchFailed} failed`);
  }

  private isPermanentError(err: unknown): boolean {
    if (isPermanentRecipientError(err)) {
      return true;
    }

    const message = (err as Error)?.message?.toLowerCase() || '';

    return (
      message.includes('invalid email') ||
      message.includes('email not found') ||
      message.includes('blocked') ||
      message.includes('suppressed') ||
      message.includes('unsubscribed') ||
      message.includes('recipient rejected')
    );
  }

  private async finalizeCampaign(campaignId: string, totalRecipients: number) {
    const campaign = await this.prisma.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: { sentCount: true, failedCount: true, status: true },
    });

    if (!campaign) {
      return;
    }

    const processedTotal = campaign.sentCount + campaign.failedCount;
    const isComplete = processedTotal >= totalRecipients;

    if (isComplete) {
      const finalStatus =
        campaign.failedCount === totalRecipients ? CampaignStatus.FAILED : CampaignStatus.COMPLETED;

      await this.prisma.promotionCampaign.update({
        where: { id: campaignId },
        data: {
          status: finalStatus,
          sentAt: new Date(),
        },
      });

      this.logger.log(
        `Campaign ${campaignId} finalized: ${finalStatus} (sent: ${campaign.sentCount}, failed: ${campaign.failedCount})`,
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<PromotionMailJobData>, err: Error) {
    this.logger.error(`Job ${job.id} failed: ${err.message}`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<PromotionMailJobData>) {
    this.logger.debug(`Job ${job.id} completed`);
  }
}