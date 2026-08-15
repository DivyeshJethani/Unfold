import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

type CreditReason =
  | 'QUIZ_COMPLETED'
  | 'REVISION_TEST_PASSED'
  | 'TAUGHT_AI_SUCCESSFULLY'
  | 'TAUGHT_PEER_SUCCESSFULLY'
  | 'PEER_IMPROVED_AFTER_TEACHING'
  | 'STREAK_BONUS'
  | 'REDEEMED';

@Injectable()
export class CreditService {
  constructor(private readonly prisma: PrismaService) {}

  async award(params: { studentId: string; amount: number; reason: CreditReason; refId?: string }) {
    if (params.amount <= 0) throw new BadRequestException('Award amount must be positive');

    return this.prisma.$transaction(async (tx) => {
      await tx.creditWallet.upsert({
        where: { studentId: params.studentId },
        create: { studentId: params.studentId, balance: params.amount, lifetimeEarned: params.amount },
        update: {
          balance: { increment: params.amount },
          lifetimeEarned: { increment: params.amount },
        },
      });

      return tx.creditTransaction.create({
        data: {
          studentId: params.studentId,
          amount: params.amount,
          reason: params.reason,
          refId: params.refId,
        },
      });
    });
  }

  async redeem(params: { studentId: string; rewardItemId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const [wallet, item] = await Promise.all([
        tx.creditWallet.findUnique({ where: { studentId: params.studentId } }),
        tx.rewardCatalogItem.findUnique({ where: { id: params.rewardItemId } }),
      ]);

      if (!item || !item.active) throw new NotFoundException('Reward not available');
      if (item.stock <= 0) throw new BadRequestException('Reward out of stock');
      if (!wallet || wallet.balance < item.creditCost) {
        throw new BadRequestException('Insufficient credit balance');
      }

      await tx.creditWallet.update({
        where: { studentId: params.studentId },
        data: { balance: { decrement: item.creditCost } },
      });
      await tx.rewardCatalogItem.update({
        where: { id: item.id },
        data: { stock: { decrement: 1 } },
      });
      const transaction = await tx.creditTransaction.create({
        data: {
          studentId: params.studentId,
          amount: -item.creditCost,
          reason: 'REDEEMED',
          refId: item.id,
        },
      });

      return { transaction, item };
    });
  }

  async getWallet(studentId: string) {
    const wallet = await this.prisma.creditWallet.findUnique({ where: { studentId } });
    return wallet ?? { studentId, balance: 0, lifetimeEarned: 0 };
  }

  async getHistory(studentId: string, take = 50) {
    return this.prisma.creditTransaction.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async getLeaderboard(studyGroupId: string, take = 10) {
    const members = await this.prisma.studyGroupMember.findMany({
      where: { studyGroupId },
      select: { studentId: true },
    });
    const wallets = await this.prisma.creditWallet.findMany({
      where: { studentId: { in: members.map((m) => m.studentId) } },
      orderBy: { lifetimeEarned: 'desc' },
      take,
    });
    return wallets;
  }
}
