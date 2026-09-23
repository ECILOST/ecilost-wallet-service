import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { WalletService } from './wallet.service';
describe('Wallet holds', () => {
  it('does not change balances when a hold is replayed at the same amount', async () => {
    const tx = { wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'w' }) }, walletHold: { findUnique: vi.fn().mockResolvedValue({ walletId: 'w', amount: new Prisma.Decimal(10) }) } };
    const service = new WalletService({ $transaction: vi.fn((fn) => fn(tx)) } as never, { getOrThrow: vi.fn().mockReturnValue('100') } as never);
    await expect(service.hold('u', 'bid:r:u', 10)).resolves.toEqual({ accepted: true, replayed: true });
  });
});
