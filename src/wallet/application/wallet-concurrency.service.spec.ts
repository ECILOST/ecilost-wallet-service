import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WALLET_TX_ATTEMPTS, WalletService, retryBackoffMs } from './wallet.service';

const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'test' });
const decimal = (value: number) => new Prisma.Decimal(value);

function serviceWith(tx: unknown, transaction = vi.fn((fn) => fn(tx))) {
  return { transaction, service: new WalletService({ $transaction: transaction } as never, { getOrThrow: vi.fn().mockReturnValue('100') } as never) };
}

function holdTx(hold: { walletId: string; amount: Prisma.Decimal } | null) {
  return {
    wallet: { update: vi.fn().mockResolvedValue({ id: 'w' }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    walletHold: { findUnique: vi.fn().mockResolvedValue(hold), upsert: vi.fn(), delete: vi.fn() },
    walletTransaction: { create: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
  };
}

describe('Concurrencia de wallet sin SERIALIZABLE', () => {
  afterEach(() => vi.restoreAllMocks());

  it('todas las operaciones corren en READ COMMITTED', async () => {
    const tx = holdTx({ walletId: 'w', amount: decimal(10) });
    Object.assign(tx.wallet, { findUnique: vi.fn().mockResolvedValue({ id: 'w' }) });
    Object.assign(tx.walletHold, { findMany: vi.fn().mockResolvedValue([]) });
    const { service, transaction } = serviceWith(tx);

    await service.hold('u', 'bid:r:u', 10);
    await service.release('u', 'bid:r:u', 10);
    await service.settleRound('r', 'u');
    await service.recharge('u', 5, 'staff');

    expect(transaction).toHaveBeenCalledTimes(4);
    for (const call of transaction.mock.calls) {
      expect((call as unknown[])[1]).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    }
  });

  it('una reserva bloquea la billetera antes de leer la reserva vigente', async () => {
    const tx = holdTx({ walletId: 'w', amount: decimal(10) });
    await serviceWith(tx).service.hold('u', 'bid:r:u', 30);

    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'u' }, data: { updatedAt: expect.any(Date) } });
    const locked = tx.wallet.update.mock.invocationCallOrder[0];
    expect(locked).toBeLessThan(tx.walletHold.findUnique.mock.invocationCallOrder[0]);
    // El delta sale de la reserva leida bajo el bloqueo: 30 - 10.
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'w', availableBalance: { gte: decimal(20) } },
      data: { availableBalance: { decrement: decimal(20) }, heldBalance: { increment: decimal(20) } },
    });
  });

  it('una liberacion bloquea la billetera antes de leer la reserva', async () => {
    const tx = holdTx({ walletId: 'w', amount: decimal(10) });
    await serviceWith(tx).service.release('u', 'bid:r:u', 10);
    expect(tx.wallet.update.mock.invocationCallOrder[0]).toBeLessThan(tx.walletHold.findUnique.mock.invocationCallOrder[0]);
  });

  it('una billetera inexistente sigue respondiendo 404', async () => {
    const tx = holdTx(null);
    tx.wallet.update.mockRejectedValue(prismaError('P2025'));
    await expect(serviceWith(tx).service.hold('nadie', 'bid:r:nadie', 10)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.walletHold.findUnique).not.toHaveBeenCalled();
  });

  describe('liquidacion', () => {
    const hold = (user: string, amount: number) => ({ walletId: `w-${user}`, reference: `bid:r:${user}`, amount: decimal(amount) });

    function settleTx(listed: ReturnType<typeof hold>[], current: ReturnType<typeof hold>[]) {
      const order: string[] = [];
      const tx = {
        wallet: {
          update: vi.fn(({ where }) => { order.push(`lock ${where.id}`); return Promise.resolve({}); }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        walletHold: {
          findMany: vi.fn().mockResolvedValue(listed),
          findUnique: vi.fn(({ where }) => { order.push(`read ${where.reference}`); return Promise.resolve(current.find((h) => h.reference === where.reference) ?? null); }),
          delete: vi.fn(),
        },
        walletTransaction: { create: vi.fn() },
      };
      return { tx, order };
    }

    it('pide las reservas en orden de billetera y relee cada una despues de bloquearla', async () => {
      const holds = [hold('a', 100), hold('b', 50)];
      const { tx, order } = settleTx(holds, holds);
      await serviceWith(tx).service.settleRound('r', 'a');

      expect(tx.walletHold.findMany).toHaveBeenCalledWith({ where: { reference: { startsWith: 'bid:r:' } }, orderBy: { walletId: 'asc' } });
      expect(order).toEqual(['lock w-a', 'read bid:r:a', 'lock w-b', 'read bid:r:b']);
    });

    it('si otra liquidacion de la misma ronda se adelanto, no mueve nada ni cobra dos veces', async () => {
      const { tx } = settleTx([hold('a', 100), hold('b', 50)], []);
      await expect(serviceWith(tx).service.settleRound('r', 'a')).resolves.toEqual({ roundId: 'r', debited: null, refunded: null, shortfall: null, released: 0 });
      expect(tx.wallet.updateMany).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      expect(tx.walletHold.delete).not.toHaveBeenCalled();
    });

    it('usa el importe vigente de la reserva, no el de la lista inicial', async () => {
      const { tx } = settleTx([hold('a', 100)], [hold('a', 300)]);
      await expect(serviceWith(tx).service.settleRound('r', 'a')).resolves.toMatchObject({ debited: '300.00' });
      expect(tx.wallet.updateMany).toHaveBeenCalledWith({
        where: { id: 'w-a', heldBalance: { gte: decimal(300) } },
        data: { heldBalance: { decrement: decimal(300) } },
      });
    });
  });

  describe('reintentos', () => {
    it('reintenta un deadlock pocas veces y luego lo deja a quien llama', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const transaction = vi.fn().mockRejectedValue(prismaError('P2034'));
      await expect(serviceWith(null, transaction).service.settleRound('r', null)).rejects.toMatchObject({ code: 'P2034' });
      expect(transaction).toHaveBeenCalledTimes(WALLET_TX_ATTEMPTS);
    });

    it('un deadlock seguido de exito responde normalmente', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const tx = holdTx({ walletId: 'w', amount: decimal(10) });
      const transaction = vi.fn().mockRejectedValueOnce(prismaError('P2034')).mockImplementationOnce((fn) => fn(tx));
      await expect(serviceWith(null, transaction).service.hold('u', 'bid:r:u', 10)).resolves.toEqual({ accepted: true, replayed: true });
      expect(transaction).toHaveBeenCalledTimes(2);
    });

    it('no reintenta lo que no es un deadlock', async () => {
      const transaction = vi.fn().mockRejectedValue(new Error('Insufficient available ECICoin'));
      await expect(serviceWith(null, transaction).service.hold('u', 'bid:r:u', 10)).rejects.toThrow('Insufficient available ECICoin');
      expect(transaction).toHaveBeenCalledOnce();
    });

    it('las esperas entre reintentos son breves y al azar, para no alargar una puja', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9999);
      const waits = Array.from({ length: WALLET_TX_ATTEMPTS - 1 }, (_, attempt) => retryBackoffMs(attempt));
      expect(waits).toEqual([19, 39]);
      expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(100);
    });
  });
});
