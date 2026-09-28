import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { ChatThreadType, Prisma, UserRole } from '@prisma/client';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrFindThread(user: AuthenticatedUser, vendorId?: string) {
    if (vendorId) {
      const vendor = await this.prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { id: true, userId: true, status: true },
      });

      if (!vendor) {
        throw new NotFoundException('Vendor not found');
      }

      if (vendor.userId === user.id) {
        throw new ForbiddenException('Cannot create thread with yourself');
      }

      let thread = await this.prisma.chatThread.findFirst({
        where: {
          buyerId: user.id,
          vendorId: vendor.id,
          type: ChatThreadType.BUYER_VENDOR,
        },
      });

      if (!thread) {
        thread = await this.prisma.chatThread.create({
          data: {
            buyerId: user.id,
            vendorId: vendor.id,
            type: ChatThreadType.BUYER_VENDOR,
            status: 'OPEN',
          },
          include: {
            buyer: { select: { id: true, name: true, email: true } },
            vendor: { select: { id: true, businessName: true, slug: true } },
          },
        });

        await this.prisma.chatParticipantState.createMany({
          data: [
            { threadId: thread.id, userId: user.id, unreadCount: 0 },
            { threadId: thread.id, userId: vendor.userId, unreadCount: 0 },
          ],
        });
      }

      return thread;
    } else {
      let thread = await this.prisma.chatThread.findFirst({
        where: {
          buyerId: user.id,
          type: ChatThreadType.BUYER_SUPPORT,
          adminId: null,
        },
      });

      if (!thread) {
        thread = await this.prisma.chatThread.create({
          data: {
            buyerId: user.id,
            type: ChatThreadType.BUYER_SUPPORT,
            status: 'OPEN',
            adminId: null,
          },
          include: {
            buyer: { select: { id: true, name: true, email: true } },
          },
        });

        await this.prisma.chatParticipantState.create({
          data: { threadId: thread.id, userId: user.id, unreadCount: 0 },
        });
      }

      return thread;
    }
  }

  async getUserThreads(user: AuthenticatedUser, page = 1, limit = 20) {
    const where: Prisma.ChatThreadWhereInput = {};

    if (user.role === UserRole.CUSTOMER) {
      where.buyerId = user.id;
    } else if (user.role === UserRole.VENDOR || user.role === UserRole.VENDOR_STAFF) {
      if (!user.vendor?.id) {
        return {
          items: [],
          meta: { total: 0, page, limit, totalPages: 0 },
        };
      }
      where.vendorId = user.vendor.id;
    } else if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
      where.OR = [
        { adminId: user.id },
        { adminId: null, type: ChatThreadType.BUYER_SUPPORT },
      ];
    }

    const [threads, total] = await Promise.all([
      this.prisma.chatThread.findMany({
        where,
        include: {
          buyer: { select: { id: true, name: true, email: true, avatarUrl: true } },
          vendor: { select: { id: true, businessName: true, slug: true, logoUrl: true } },
          admin: { select: { id: true, name: true, email: true } },
          messages: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: { id: true, content: true, attachmentUrl: true, senderId: true, createdAt: true },
          },
          participantStates: {
            where: { userId: user.id },
            select: { unreadCount: true, lastReadMessageId: true },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.chatThread.count({ where }),
    ]);

    return {
      items: threads.map((thread) => ({
        ...thread,
        unreadCount: thread.participantStates[0]?.unreadCount ?? 0,
        lastMessage: thread.messages[0] ?? null,
        participantStates: undefined,
        messages: undefined,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getThreadMessages(threadId: string, user: AuthenticatedUser, page = 1, limit = 50) {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: { id: true, buyerId: true, vendorId: true, adminId: true, type: true },
    });

    if (!thread) {
      throw new NotFoundException('Thread not found');
    }

    const isParticipant = await this.validateThreadParticipant(threadId, user);
    if (!isParticipant) {
      throw new ForbiddenException('Not a participant of this thread');
    }

    const [messages, total] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { threadId, deletedAt: null },
        include: {
          sender: { select: { id: true, name: true, email: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.chatMessage.count({ where: { threadId, deletedAt: null } }),
    ]);

    return {
      items: messages,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async sendMessage(
    threadId: string,
    senderId: string,
    content: string,
    attachmentUrl?: string,
  ) {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      include: { participantStates: true },
    });

    if (!thread) {
      throw new NotFoundException('Thread not found');
    }

    const message = await this.prisma.chatMessage.create({
      data: {
        threadId,
        senderId,
        content,
        attachmentUrl,
      },
      include: {
        sender: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    });

    await this.prisma.chatThread.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date() },
    });

    const otherParticipantStates = thread.participantStates.filter(
      (state) => state.userId !== senderId,
    );
    if (otherParticipantStates.length > 0) {
      await this.prisma.chatParticipantState.updateMany({
        where: { id: { in: otherParticipantStates.map((state) => state.id) } },
        data: { unreadCount: { increment: 1 } },
      });
    }

    return message;
  }

  async markAsRead(threadId: string, userId: string, messageId: string) {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { threadId: true, createdAt: true },
    });

    if (!message || message.threadId !== threadId) {
      throw new NotFoundException('Message not found in this thread');
    }

    await this.prisma.chatParticipantState.update({
      where: { threadId_userId: { threadId, userId } },
      data: {
        lastReadMessageId: messageId,
        unreadCount: 0,
      },
    });

    await this.prisma.chatMessage.updateMany({
      where: {
        threadId,
        senderId: { not: userId },
        readAt: null,
        createdAt: { lte: message.createdAt },
      },
      data: { readAt: new Date() },
    });
  }

  async validateThreadParticipant(threadId: string, user: AuthenticatedUser): Promise<boolean> {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: { buyerId: true, vendorId: true, adminId: true, type: true },
    });

    if (!thread) {
      return false;
    }

    if (thread.buyerId === user.id) {
      return true;
    }

    if (thread.vendorId && user.vendor?.id === thread.vendorId) {
      return true;
    }

    if (thread.adminId && thread.adminId === user.id) {
      return true;
    }

    if (
      thread.type === ChatThreadType.BUYER_SUPPORT &&
      thread.adminId === null &&
      (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN)
    ) {
      return true;
    }

    return false;
  }

  async assignAdminToThread(threadId: string, adminId: string, user: AuthenticatedUser) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only admins can assign threads');
    }

    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
    });

    if (!thread) {
      throw new NotFoundException('Thread not found');
    }

    if (thread.type !== ChatThreadType.BUYER_SUPPORT) {
      throw new ForbiddenException('Only BUYER_SUPPORT threads can be assigned');
    }

    if (thread.adminId) {
      throw new ForbiddenException('Thread already assigned');
    }

    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
    });

    if (!admin || (admin.role !== UserRole.ADMIN && admin.role !== UserRole.SUPER_ADMIN)) {
      throw new ForbiddenException('Assigned user must be an admin');
    }

    const updated = await this.prisma.chatThread.update({
      where: { id: threadId },
      data: { adminId },
      include: {
        buyer: { select: { id: true, name: true, email: true } },
        admin: { select: { id: true, name: true, email: true } },
      },
    });

    await this.prisma.chatParticipantState.create({
      data: { threadId, userId: adminId, unreadCount: 0 },
    });

    return updated;
  }
}