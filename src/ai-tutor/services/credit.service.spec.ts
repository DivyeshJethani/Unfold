import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CreditService } from './credit.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('CreditService', () => {
  let service: CreditService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      creditWallet: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      creditTransaction: {
        create: jest.fn().mockImplementation(({ data }) => data),
        findMany: jest.fn(),
      },
      rewardCatalogItem: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation((fn) => fn(prisma)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [CreditService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(CreditService);
  });

  it('rejects awarding a non-positive amount', async () => {
    await expect(
      service.award({ studentId: 's1', amount: 0, reason: 'QUIZ_COMPLETED' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('awards credits and records a transaction', async () => {
    const tx = await service.award({ studentId: 's1', amount: 15, reason: 'TAUGHT_AI_SUCCESSFULLY' });
    expect(prisma.creditWallet.upsert).toHaveBeenCalled();
    expect(tx.amount).toBe(15);
    expect(tx.reason).toBe('TAUGHT_AI_SUCCESSFULLY');
  });

  it('refuses to redeem an inactive or missing reward', async () => {
    prisma.rewardCatalogItem.findUnique.mockResolvedValue(null);
    await expect(
      service.redeem({ studentId: 's1', rewardItemId: 'r1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses to redeem when balance is insufficient', async () => {
    prisma.rewardCatalogItem.findUnique.mockResolvedValue({
      id: 'r1',
      active: true,
      stock: 5,
      creditCost: 100,
    });
    prisma.creditWallet.findUnique.mockResolvedValue({ balance: 10 });

    await expect(
      service.redeem({ studentId: 's1', rewardItemId: 'r1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('successfully redeems when balance and stock are sufficient', async () => {
    prisma.rewardCatalogItem.findUnique.mockResolvedValue({
      id: 'r1',
      active: true,
      stock: 5,
      creditCost: 50,
    });
    prisma.creditWallet.findUnique.mockResolvedValue({ balance: 100 });

    const result = await service.redeem({ studentId: 's1', rewardItemId: 'r1' });

    expect(prisma.creditWallet.update).toHaveBeenCalledWith({
      where: { studentId: 's1' },
      data: { balance: { decrement: 50 } },
    });
    expect(result.transaction.amount).toBe(-50);
  });
});
