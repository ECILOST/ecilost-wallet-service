import { ConfigService } from '@nestjs/config';
import { Prisma, WalletTransactionType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from './wallet.service';

describe('WalletService', () => {
  it('emite el saldo inicial solo al crear la wallet', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'wallet-1' });
    const prisma = { wallet: { upsert } } as unknown as PrismaService;
    const config = { getOrThrow: vi.fn().mockReturnValue('100') } as unknown as ConfigService;
    const service = new WalletService(prisma, config);

    await service.bootstrap('student-1');

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'student-1' },
        update: {},
        create: expect.objectContaining({
          availableBalance: new Prisma.Decimal(100),
          transactions: expect.objectContaining({
            create: expect.objectContaining({
              type: WalletTransactionType.INITIAL_ISSUANCE,
              reference: 'initial:student-1',
            }),
          }),
        }),
      }),
    );
  });

  it('recarga saldo y registra el movimiento dentro de una transacción', async () => {
    const wallet = { id: 'wallet-1', userId: 'student-1', availableBalance: new Prisma.Decimal(100) };
    const updatedWallet = { ...wallet, availableBalance: new Prisma.Decimal(125) };
    const createdTransaction = { id: 'transaction-1', type: WalletTransactionType.ADMIN_RECHARGE };
    const tx = {
      wallet: {
        findUnique: vi.fn().mockResolvedValue(wallet),
        update: vi.fn().mockResolvedValue(updatedWallet),
      },
      walletTransaction: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(createdTransaction),
      },
    };
    const transaction = vi.fn(async (callback) => callback(tx));
    const prisma = { $transaction: transaction } as unknown as PrismaService;
    const config = {} as ConfigService;
    const service = new WalletService(prisma, config);

    const result = await service.recharge('student-1', 25, 'staff-1', 'recharge-1');

    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { availableBalance: { increment: new Prisma.Decimal(25) } } }),
    );
    expect(tx.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: WalletTransactionType.ADMIN_RECHARGE,
          reference: 'recharge-1',
          metadata: { processedBy: 'staff-1' },
        }),
      }),
    );
    expect(result).toEqual({ wallet: updatedWallet, transaction: createdTransaction, replayed: false });
  });

  it('devuelve saldos en cero para una wallet sin movimientos', async () => {
    const prisma = {
      wallet: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new WalletService(prisma, {} as ConfigService);

    await expect(service.getBalance('student-without-wallet')).resolves.toEqual({
      availableBalance: '0.00',
      heldBalance: '0.00',
      totalBalance: '0.00',
    });
    await expect(service.listTransactions('student-without-wallet', 1, 20)).resolves.toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });
  });

  it('calcula el total y pagina el historial del usuario autenticado', async () => {
    const wallet = {
      id: 'wallet-1',
      userId: 'student-1',
      availableBalance: new Prisma.Decimal(75),
      heldBalance: new Prisma.Decimal(25),
    };
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'transaction-1',
        type: WalletTransactionType.ADMIN_RECHARGE,
        amount: new Prisma.Decimal(25),
        createdAt: new Date('2026-09-19T12:00:00.000Z'),
      },
    ]);
    const prisma = {
      wallet: { findUnique: vi.fn().mockResolvedValue(wallet) },
      walletTransaction: { findMany, count: vi.fn().mockResolvedValue(1) },
    } as unknown as PrismaService;
    const service = new WalletService(prisma, {} as ConfigService);

    await expect(service.getBalance('student-1')).resolves.toEqual({
      availableBalance: '75.00',
      heldBalance: '25.00',
      totalBalance: '100.00',
    });
    await expect(service.listTransactions('student-1', 2, 10)).resolves.toMatchObject({
      page: 2,
      pageSize: 10,
      total: 1,
      items: [{ id: 'transaction-1', type: WalletTransactionType.ADMIN_RECHARGE, amount: '25.00' }],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10, orderBy: { createdAt: 'desc' } }),
    );
  });
});
