import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient, WalletTransactionType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WalletService } from '../src/wallet/application/wallet.service';
import { integrationDatabaseUrl } from './database';

/**
 * Las garantias de dinero de wallet contra PostgreSQL real y con operaciones simultaneas, que
 * es donde se rompian (hallazgos H2 a H4 de las pruebas de carga). Los mocks de las unitarias
 * no prueban bloqueos ni aislamiento; esto si.
 */
const prisma = new PrismaClient({ datasourceUrl: withPool(integrationDatabaseUrl, 30) });
const service = new WalletService(prisma as never, { getOrThrow: () => '0' } as never);

function withPool(url: string, connections: number) {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(connections));
  return parsed.toString();
}

async function createWallet(available: number) {
  const userId = `user-${randomUUID()}`;
  await prisma.wallet.create({ data: { userId, availableBalance: new Prisma.Decimal(available) } });
  return userId;
}

/** Cada billetera: nada negativo y lo retenido igual a la suma de sus reservas vigentes. */
async function expectBalancesConsistent() {
  const wallets = await prisma.wallet.findMany({ include: { holds: true } });
  for (const wallet of wallets) {
    expect(wallet.availableBalance.isNegative()).toBe(false);
    expect(wallet.heldBalance.isNegative()).toBe(false);
    const held = wallet.holds.reduce((total, hold) => total.plus(hold.amount), new Prisma.Decimal(0));
    expect(wallet.heldBalance.toString()).toBe(held.toString());
  }
}

describe('Wallet con PostgreSQL real y operaciones simultaneas', () => {
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "wallet"."wallet_transactions", "wallet"."wallet_holds", "wallet"."wallets"');
  });

  it('reservas simultaneas en billeteras distintas se aceptan todas (H2)', async () => {
    const users = await Promise.all(Array.from({ length: 40 }, () => createWallet(1_000)));

    const results = await Promise.allSettled(users.map((userId) => service.hold(userId, `bid:round-a:${userId}`, 500)));

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(await prisma.walletHold.count()).toBe(40);
    await expectBalancesConsistent();
  });

  it('reservas simultaneas en la misma billetera nunca comprometen mas que el saldo', async () => {
    const userId = await createWallet(1_000);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, round) => service.hold(userId, `bid:round-${round}:${userId}`, 100)),
    );

    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(accepted).toHaveLength(10);
    for (const { reason } of rejected) expect(reason).toBeInstanceOf(ConflictException);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.availableBalance.toString()).toBe('0');
    expect(wallet.heldBalance.toString()).toBe('1000');
    await expectBalancesConsistent();
  });

  it('mejoras simultaneas de la misma reserva no duplican el compromiso', async () => {
    const userId = await createWallet(10_000);
    const reference = `bid:round-a:${userId}`;

    await Promise.allSettled([200, 300, 400, 500, 600, 700].map((amount) => service.hold(userId, reference, amount)));

    // Gane la que gane, lo retenido es exactamente la reserva vigente.
    const hold = await prisma.walletHold.findUniqueOrThrow({ where: { reference } });
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.heldBalance.toString()).toBe(hold.amount.toString());
    expect(wallet.availableBalance.plus(wallet.heldBalance).toString()).toBe('10000');
  });

  it('liberar y reservar a la vez la misma referencia deja el saldo cuadrado', async () => {
    const userId = await createWallet(5_000);
    const reference = `bid:round-a:${userId}`;
    await service.hold(userId, reference, 1_000);

    await Promise.allSettled([service.release(userId, reference, 1_000), service.hold(userId, reference, 2_000)]);

    await expectBalancesConsistent();
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.availableBalance.plus(wallet.heldBalance).toString()).toBe('5000');
  });

  it('liquidaciones simultaneas de la misma ronda cobran una sola vez y liberan a los demas', async () => {
    const [winner, ...others] = await Promise.all(Array.from({ length: 10 }, () => createWallet(10_000)));
    await Promise.all([winner, ...others].map((userId, index) => service.hold(userId, `bid:round-x:${userId}`, 1_000 + index * 100)));

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.settleRound('round-x', winner, new Prisma.Decimal(1_000))),
    );

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const debits = await prisma.walletTransaction.findMany({ where: { type: WalletTransactionType.DEBIT } });
    expect(debits).toHaveLength(1);
    expect(debits[0].reference).toBe('settle:round-x');
    expect(debits[0].amount.toString()).toBe('1000');
    expect(await prisma.walletHold.count()).toBe(0);
    for (const userId of others) {
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
      expect(wallet.availableBalance.toString()).toBe('10000');
    }
    const paid = await prisma.wallet.findUniqueOrThrow({ where: { userId: winner } });
    expect(paid.availableBalance.toString()).toBe('9000');
    await expectBalancesConsistent();
  });

  it('una liquidacion termina mientras otras rondas reservan sobre las mismas billeteras (H4)', async () => {
    const users = await Promise.all(Array.from({ length: 25 }, () => createWallet(100_000)));
    await Promise.all(users.map((userId, index) => service.hold(userId, `bid:closing:${userId}`, 1_000 + index)));

    const storm = users.flatMap((userId) =>
      Array.from({ length: 4 }, (_, step) => service.hold(userId, `bid:open-${step}:${userId}`, 500 + step)),
    );
    const [settlement] = await Promise.allSettled([service.settleRound('closing', users[0]), ...storm]);

    expect(settlement.status).toBe('fulfilled');
    expect(await prisma.walletHold.count({ where: { reference: { startsWith: 'bid:closing:' } } })).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { reference: 'settle:closing' } })).toBe(1);
    await expectBalancesConsistent();
  });

  it('recargas simultaneas a billeteras distintas no fallan', async () => {
    const users = await Promise.all(Array.from({ length: 30 }, () => createWallet(0)));

    const results = await Promise.allSettled(users.map((userId) => service.recharge(userId, 250, 'staff', `recharge:${userId}`)));

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const total = await prisma.wallet.aggregate({ _sum: { availableBalance: true } });
    expect(total._sum.availableBalance?.toString()).toBe('7500');
  });
});
