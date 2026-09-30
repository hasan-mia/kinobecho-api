import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReviewStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { NotificationService } from '../notification/notification.service';
import {
  CreateAnswerDto,
  CreateQuestionDto,
  ListQuestionsQueryDto,
  ModerateQuestionDto,
} from './dto/question.dto';

const QUESTION_INCLUDE = {
  user: { select: { id: true, name: true, avatarUrl: true } },
  answers: {
    orderBy: { createdAt: 'asc' },
    include: { answeredBy: { select: { id: true, name: true, avatarUrl: true } } },
  },
} satisfies Prisma.ProductQuestionInclude;

@Injectable()
export class QuestionsService {
  private readonly logger = new Logger(QuestionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
  }

  /**
   * Files a question.
   *
   * It starts PENDING: unmoderated user text about a product is not published
   * to the storefront until a moderator has read it, exactly like a review.
   */
  async ask(user: AuthenticatedUser, productId: string, dto: CreateQuestionDto) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, name: true, vendorId: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const question = await this.prisma.productQuestion.create({
      data: {
        productId: product.id,
        userId: user.id,
        question: dto.question.trim(),
        status: ReviewStatus.PENDING,
      },
      include: QUESTION_INCLUDE,
    });

    await this.notifyVendor(product, user, question);

    return question;
  }

  /**
   * Public listing of APPROVED questions with their answers.
   *
   * Only approved rows are ever read here — the filter is in the query rather
   * than applied after, so a pending question cannot leak through a forgotten
   * `if`.
   */
  async listForProduct(
    productId: string,
    query: ListQuestionsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const where: Prisma.ProductQuestionWhereInput = {
      productId: product.id,
      status: ReviewStatus.APPROVED,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.productQuestion.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: QUESTION_INCLUDE,
      }),
      this.prisma.productQuestion.count({ where }),
    ]);

    return {
      items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * The current user's own questions, including the ones still pending.
   *
   * Without this a buyer who asked something gets no trace of it and no way to
   * see whether it was answered.
   */
  async listMine(user: AuthenticatedUser, query: ListQuestionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.productQuestion.findMany({
        where: { userId: user.id },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          ...QUESTION_INCLUDE,
          product: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.productQuestion.count({ where: { userId: user.id } }),
    ]);

    return {
      items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Answers a question.
   *
   * Only the vendor who sells the product, or an admin, may answer — an answer
   * reads as the seller's word on the product page, so a stranger must not be
   * able to post one.
   *
   * Answering a PENDING question approves it: the vendor has vouched for the
   * text by replying to it, and forcing the asker to wait for a separate
   * moderation pass would hide a question the seller is willing to stand behind.
   */
  async answer(
    user: AuthenticatedUser,
    questionId: string,
    dto: CreateAnswerDto,
  ) {
    const question = await this.requireAnswerable(user, questionId);

    const isVendor = !this.isAdmin(user) && !!user.vendor;

    const answer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.productAnswer.create({
        data: {
          questionId: question.id,
          answeredById: user.id,
          isVendor,
          answer: dto.answer.trim(),
        },
        include: { answeredBy: { select: { id: true, name: true, avatarUrl: true } } },
      });

      await tx.productQuestion.update({
        where: { id: question.id },
        data: {
          status: ReviewStatus.APPROVED,
          answeredAt: new Date(),
        },
      });

      return created;
    });

    await this.notifyAsker(question, user, answer);

    return answer;
  }

  private async requireAnswerable(
    user: AuthenticatedUser,
    questionId: string,
  ) {
    const question = await this.prisma.productQuestion.findUnique({
      where: { id: questionId },
      include: {
        user: { select: { id: true, email: true, name: true } },
        product: { select: { id: true, name: true, vendorId: true } },
      },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const ownsProduct = user.vendor?.id === question.product.vendorId;

    if (!this.isAdmin(user) && !ownsProduct) {
      throw new ForbiddenException(
        'Only the vendor who sells this product can answer its questions',
      );
    }

    return question;
  }

  /** Admin approval or rejection. A rejection needs a reason for the audit log. */
  async moderate(
    user: AuthenticatedUser,
    questionId: string,
    dto: ModerateQuestionDto,
  ) {
    if (dto.status === ReviewStatus.PENDING) {
      throw new BadRequestException(
        'A question can only be approved or rejected',
      );
    }

    if (dto.status === ReviewStatus.REJECTED && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required when rejecting a question');
    }

    const question = await this.prisma.productQuestion.findUnique({
      where: { id: questionId },
      select: { id: true },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    return this.prisma.productQuestion.update({
      where: { id: question.id },
      data: {
        status: dto.status,
        moderatedById: user.id,
        // A rejection without a reason would leave the asker with a question
        // that disappeared for no stated cause.
        note: dto.reason?.trim() ?? null,
      },
      include: QUESTION_INCLUDE,
    });
  }

  private async notifyVendor(
    product: { id: string; name: string; vendorId: string },
    asker: AuthenticatedUser,
    question: { id: string; question: string },
  ): Promise<void> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: product.vendorId },
      select: { businessName: true, userId: true },
    });

    if (!vendor?.userId) {
      return;
    }

    const email = await this.emailOf(vendor.userId);

    if (!email) {
      return;
    }

    await this.tryNotify(() =>
      this.notifications.sendTransactionalEmail(
        vendor.userId,
        email,
        `New question about ${product.name}`,
        'product-question',
        {
          name: vendor.businessName,
          productName: product.name,
          productId: product.id,
          askerName: asker.name,
          question: question.question,
          questionId: question.id,
        },
      ),
    );
  }

  private async notifyAsker(
    question: {
      id: string;
      question: string;
      user: { id: string; email: string | null; name: string };
      product: { id: string; name: string };
    },
    answerer: AuthenticatedUser,
    answer: { answer: string },
  ): Promise<void> {
    const email = question.user.email;

    if (!email) {
      return;
    }

    await this.tryNotify(() =>
      this.notifications.sendTransactionalEmail(
        question.user.id,
        email,
        `Your question about ${question.product.name} was answered`,
        'product-answer',
        {
          name: question.user.name,
          productName: question.product.name,
          productId: question.product.id,
          question: question.question,
          answer: answer.answer,
          answeredBy: answerer.name,
          questionId: question.id,
        },
      ),
    );
  }

  /**
   * A notification failure must not roll back the question or the answer that
   * was already written. NotificationService has already logged the failure.
   */
  private async tryNotify(send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (err) {
      this.logger.warn(
        `Question notification failed: ${(err as Error).message}`,
      );
    }
  }

  private async emailOf(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    return user?.email ?? null;
  }
}
