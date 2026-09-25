import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { WalletService } from './wallet.service';

const hold = (userId: string, amount: number, walletId = `w-${userId}`) => ({
  walletId, reference: `bid:round:${userId}`, amount: new Prisma.Decimal(amount),
});

function setup(holds: ReturnType<typeof hold>[]) {
  const tx = {
    walletHold: { findMany: vi.fn().mockResolvedValue(holds), delete: vi.fn() },
    wallet: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    walletTransaction: { create: vi.fn() },
  };
  const service = new WalletService({ $transaction: vi.fn((fn) => fn(tx)) } as never, { getOrThrow: vi.fn() } as never);
  return { tx, service };
}

describe('Round settlement', () => {
  it('turns the winner hold into a debit and releases every other hold of the round', async () => {
    const { tx, service } = setup([hold('alice', 200), hold('bob', 50)]);

    await expect(service.settleRound('round', 'alice')).resolves.toEqual({ roundId: 'round', debited: '200.00', released: 1 });

    expect(tx.walletHold.findMany).toHaveBeenCalledWith({ where: { reference: { startsWith: 'bid:round:' } } });
    // Ganador: sale de lo comprometido y no vuelve al disponible.
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'w-alice', heldBalance: { gte: new Prisma.Decimal(200) } },
      data: { heldBalance: { decrement: new Prisma.Decimal(200) } },
    });
    // No ganador: vuelve integro al disponible.
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'w-bob', heldBalance: { gte: new Prisma.Decimal(50) } },
      data: { heldBalance: { decrement: new Prisma.Decimal(50) }, availableBalance: { increment: new Prisma.Decimal(50) } },
    });
    const types = tx.walletTransaction.create.mock.calls.map(([{ data }]) => [data.type, data.reference ?? null]);
    expect(types).toEqual([['DEBIT', 'settle:round'], ['RELEASE', null]]);
    expect(tx.walletHold.delete).toHaveBeenCalledTimes(2);
  });

  it('a deserted round creates no debit and releases every hold', async () => {
    const { tx, service } = setup([hold('bob', 50)]);

    await expect(service.settleRound('round', null)).resolves.toEqual({ roundId: 'round', debited: null, released: 1 });
    expect(tx.walletTransaction.create.mock.calls.map(([{ data }]) => data.type)).toEqual(['RELEASE']);
  });

  it('a redelivered event finds no holds left and moves nothing', async () => {
    const { tx, service } = setup([]);

    await expect(service.settleRound('round', 'alice')).resolves.toEqual({ roundId: 'round', debited: null, released: 0 });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('never leaves a half-settled round when the balance invariant breaks', async () => {
    const { tx, service } = setup([hold('alice', 200)]);
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.settleRound('round', 'alice')).rejects.toThrow('Wallet hold invariant was violated');
    expect(tx.walletHold.delete).not.toHaveBeenCalled();
  });
});
