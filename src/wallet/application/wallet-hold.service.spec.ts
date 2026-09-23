import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { WalletService } from './wallet.service';
describe('Wallet holds', () => {
  it('does not change balances when a hold is replayed at the same amount', async () => {
    const tx = { wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'w' }) }, walletHold: { findUnique: vi.fn().mockResolvedValue({ walletId: 'w', amount: new Prisma.Decimal(10) }) } };
    const service = new WalletService({ $transaction: vi.fn((fn) => fn(tx)) } as never, { getOrThrow: vi.fn().mockReturnValue('100') } as never);
    await expect(service.hold('u', 'bid:r:u', 10)).resolves.toEqual({ accepted: true, replayed: true });
  });
  it('releases a matching hold and records an auditable release transaction', async () => {
    const hold = { walletId: 'w', amount: new Prisma.Decimal(10) };
    const tx = {
      wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'w' }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      walletHold: { findUnique: vi.fn().mockResolvedValue(hold), delete: vi.fn() },
      walletTransaction: { create: vi.fn() },
    };
    const service = new WalletService({ $transaction: vi.fn((fn) => fn(tx)) } as never, { getOrThrow: vi.fn().mockReturnValue('100') } as never);
    await expect(service.release('u', 'bid:r:u', 10)).resolves.toEqual({ accepted: true, replayed: false });
    expect(tx.wallet.updateMany).toHaveBeenCalledOnce();
    expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'RELEASE' }) }));
    expect(tx.walletHold.delete).toHaveBeenCalledWith({ where: { reference: 'bid:r:u' } });
  });
  it('does not release a newer hold when a stale outbid message arrives', async () => {
    const tx = { wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'w' }), updateMany: vi.fn() }, walletHold: { findUnique: vi.fn().mockResolvedValue({ walletId: 'w', amount: new Prisma.Decimal(20) }), delete: vi.fn() }, walletTransaction: { create: vi.fn() } };
    const service = new WalletService({ $transaction: vi.fn((fn) => fn(tx)) } as never, { getOrThrow: vi.fn().mockReturnValue('100') } as never);
    await expect(service.release('u', 'bid:r:u', 10)).resolves.toEqual({ accepted: true, replayed: true });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a reservation when the atomic available-balance condition is no longer true', async () => {
    const tx = {
      wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'w' }), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      walletHold: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      walletTransaction: { create: vi.fn() },
    };
    const service = new WalletService({ $transaction: vi.fn((fn) => fn(tx)) } as never, { getOrThrow: vi.fn().mockReturnValue('100') } as never);
    await expect(service.hold('u', 'bid:other-round:u', 80)).rejects.toThrow('Insufficient available ECICoin');
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(tx.walletHold.upsert).not.toHaveBeenCalled();
  });
  it('retries a serializable conflict before deciding the final balance result', async () => {
    const tx = { wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'w' }) }, walletHold: { findUnique: vi.fn().mockResolvedValue({ walletId: 'w', amount: new Prisma.Decimal(10) }) } };
    const serializationFailure = new Prisma.PrismaClientKnownRequestError('retry', { code: 'P2034', clientVersion: 'test' });
    const transaction = vi.fn().mockRejectedValueOnce(serializationFailure).mockImplementationOnce((fn) => fn(tx));
    const service = new WalletService({ $transaction: transaction } as never, { getOrThrow: vi.fn().mockReturnValue('100') } as never);
    await expect(service.hold('u', 'bid:r:u', 10)).resolves.toEqual({ accepted: true, replayed: true });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
