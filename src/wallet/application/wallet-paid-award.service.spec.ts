import { ConfigService } from '@nestjs/config';
import { Prisma, WalletTransactionType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from './wallet.service';

function paidDebit() {
  return {
    type: WalletTransactionType.DEBIT,
    amount: new Prisma.Decimal(100),
    wallet: { userId: 'winner' },
    metadata: { reason: 'round-awarded' },
  };
}

function setup(debit: unknown) {
  const findUnique = vi.fn().mockResolvedValue(debit);
  const prisma = { walletTransaction: { findUnique } } as unknown as PrismaService;
  return { findUnique, service: new WalletService(prisma, {} as ConfigService) };
}

describe('WalletService.hasPaidAward', () => {
  it('recognizes a persisted payment for the round and its winner', async () => {
    const { service, findUnique } = setup(paidDebit());

    await expect(service.hasPaidAward('round', 'winner')).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { reference: 'settle:round' },
      select: { amount: true, metadata: true, type: true, wallet: { select: { userId: true } } },
    });
  });

  it.each([
    ['missing settlement', null],
    ['a release instead of a debit', { ...paidDebit(), type: WalletTransactionType.RELEASE }],
    ['another winner', { ...paidDebit(), wallet: { userId: 'other-user' } }],
    ['zero payment', { ...paidDebit(), amount: new Prisma.Decimal(0) }],
    ['negative payment', { ...paidDebit(), amount: new Prisma.Decimal(-1) }],
    ['missing metadata', { ...paidDebit(), metadata: null }],
    ['string metadata', { ...paidDebit(), metadata: 'round-awarded' }],
    ['array metadata', { ...paidDebit(), metadata: [] }],
    ['missing reason', { ...paidDebit(), metadata: {} }],
    ['another reason', { ...paidDebit(), metadata: { reason: 'admin-recharge' } }],
    ['partial payment', { ...paidDebit(), metadata: { reason: 'round-awarded', shortfall: '20.00' } }],
  ])('does not report a paid award for %s', async (_description, debit) => {
    await expect(setup(debit).service.hasPaidAward('round', 'winner')).resolves.toBe(false);
  });

  it('propagates database failures so the consumer can retry instead of confirming the event', async () => {
    const { service, findUnique } = setup(null);
    const error = new Error('database unavailable');
    findUnique.mockRejectedValue(error);

    await expect(service.hasPaidAward('round', 'winner')).rejects.toBe(error);
  });
});
