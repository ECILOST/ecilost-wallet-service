import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { parseWinningAmount } from '../../events/round-settlement.consumer';
import { WalletService } from './wallet.service';

const hold = (userId: string, amount: number, walletId = `w-${userId}`) => ({
  walletId, reference: `bid:round:${userId}`, amount: new Prisma.Decimal(amount),
});

function setup(holds: ReturnType<typeof hold>[]) {
  const tx = {
    walletHold: {
      findMany: vi.fn().mockResolvedValue(holds),
      // Releida tras bloquear la billetera: sigue vigente.
      findUnique: vi.fn(({ where }) => Promise.resolve(holds.find((h) => h.reference === where.reference) ?? null)),
      delete: vi.fn(),
    },
    wallet: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    walletTransaction: { create: vi.fn() },
  };
  const service = new WalletService({ $transaction: vi.fn((fn) => fn(tx)) } as never, { getOrThrow: vi.fn() } as never);
  return { tx, service };
}

describe('Round settlement', () => {
  it('turns the winner hold into a debit and releases every other hold of the round', async () => {
    const { tx, service } = setup([hold('alice', 200), hold('bob', 50)]);

    await expect(service.settleRound('round', 'alice')).resolves.toEqual({ roundId: 'round', debited: '200.00', refunded: null, shortfall: null, released: 1 });

    expect(tx.walletHold.findMany).toHaveBeenCalledWith({ where: { reference: { startsWith: 'bid:round:' } }, orderBy: { walletId: 'asc' } });
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

    await expect(service.settleRound('round', null)).resolves.toEqual({ roundId: 'round', debited: null, refunded: null, shortfall: null, released: 1 });
    expect(tx.walletTransaction.create.mock.calls.map(([{ data }]) => data.type)).toEqual(['RELEASE']);
  });

  it('a redelivered event finds no holds left and moves nothing', async () => {
    const { tx, service } = setup([]);

    await expect(service.settleRound('round', 'alice')).resolves.toEqual({ roundId: 'round', debited: null, refunded: null, shortfall: null, released: 0 });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('never leaves a half-settled round when the balance invariant breaks', async () => {
    const { tx, service } = setup([hold('alice', 200)]);
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.settleRound('round', 'alice')).rejects.toThrow('Wallet hold invariant was violated');
    expect(tx.walletHold.delete).not.toHaveBeenCalled();
  });

  describe('cobra el precio adjudicado, no la reserva (HU-24)', () => {
    const transactions = (tx: ReturnType<typeof setup>['tx']) =>
      tx.walletTransaction.create.mock.calls.map(([{ data }]) => ({
        type: data.type, amount: data.amount.toString(), availableDelta: data.availableDelta.toString(), heldDelta: data.heldDelta.toString(),
        reference: data.reference ?? null, reason: data.metadata.reason,
      }));

    it('con la reserva igual al precio cobra la reserva y no devuelve nada', async () => {
      const { tx, service } = setup([hold('alice', 5000)]);

      await expect(service.settleRound('round', 'alice', new Prisma.Decimal(5000))).resolves.toMatchObject({ debited: '5000.00', refunded: null, shortfall: null });
      expect(tx.wallet.updateMany).toHaveBeenCalledWith({
        where: { id: 'w-alice', heldBalance: { gte: new Prisma.Decimal(5000) } },
        data: { heldBalance: { decrement: new Prisma.Decimal(5000) } },
      });
      expect(transactions(tx)).toEqual([{ type: 'DEBIT', amount: '5000', availableDelta: '0', heldDelta: '-5000', reference: 'settle:round', reason: 'round-awarded' }]);
    });

    it('con la reserva por encima del precio cobra el precio y devuelve el excedente al disponible', async () => {
      // La compra inmediata de alice perdio contra el vencimiento: lideraba con 1000 y su reserva seguia en 5000.
      const { tx, service } = setup([hold('alice', 5000), hold('bob', 300)]);

      await expect(service.settleRound('round', 'alice', new Prisma.Decimal(1000))).resolves.toEqual({
        roundId: 'round', debited: '1000.00', refunded: '4000.00', shortfall: null, released: 1,
      });
      expect(tx.wallet.updateMany).toHaveBeenCalledWith({
        where: { id: 'w-alice', heldBalance: { gte: new Prisma.Decimal(5000) } },
        data: { heldBalance: { decrement: new Prisma.Decimal(5000) }, availableBalance: { increment: new Prisma.Decimal(4000) } },
      });
      expect(transactions(tx)).toEqual([
        { type: 'DEBIT', amount: '1000', availableDelta: '0', heldDelta: '-1000', reference: 'settle:round', reason: 'round-awarded' },
        { type: 'RELEASE', amount: '4000', availableDelta: '4000', heldDelta: '-4000', reference: null, reason: 'round-awarded-excess' },
        { type: 'RELEASE', amount: '300', availableDelta: '300', heldDelta: '-300', reference: null, reason: 'round-closed' },
      ]);
      expect(tx.walletHold.delete).toHaveBeenCalledTimes(2);
    });

    it('con la reserva por debajo del precio nunca cobra mas de lo reservado e informa el faltante', async () => {
      const { tx, service } = setup([hold('alice', 800)]);

      await expect(service.settleRound('round', 'alice', new Prisma.Decimal(1000))).resolves.toMatchObject({ debited: '800.00', refunded: null, shortfall: '200.00' });
      expect(tx.walletTransaction.create).toHaveBeenCalledOnce();
      expect(tx.walletTransaction.create.mock.calls[0][0].data.metadata).toEqual({
        reference: 'bid:round:alice', reason: 'round-awarded', winningAmount: '1000.00', shortfall: '200.00',
      });
    });

    it('lee winningAmount del evento y, si falta o es invalido, cobra la reserva completa como antes', () => {
      expect(parseWinningAmount('5000')?.toString()).toBe('5000');
      expect(parseWinningAmount('5000.50')?.toString()).toBe('5000.5');
      for (const value of [undefined, null, 'abc', '-5', 5000]) expect(parseWinningAmount(value)).toBeNull();
    });
  });
});
