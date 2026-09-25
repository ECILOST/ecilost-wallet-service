import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WalletTransactionType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * La billetera de alguien, o `null` si todavia no la tiene.
   *
   * Es una lectura y por eso no crea nada: quien la consulta puede no ser quien deberia
   * provisionarla, y un `GET` que escribe convierte cualquier refresco de pantalla en una
   * escritura. Provisionar es `bootstrap`, que ademas registra la emision inicial.
   */
  async findByUser(userId: string) {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  async bootstrap(userId: string) {
    const initialBalance = this.initialBalance();
    return this.prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        availableBalance: initialBalance,
        transactions: {
          create: {
            type: WalletTransactionType.INITIAL_ISSUANCE,
            amount: initialBalance,
            availableDelta: initialBalance,
            heldDelta: new Prisma.Decimal(0),
            reference: `initial:${userId}`,
            metadata: { source: 'account-bootstrap' },
          },
        },
      },
    });
  }

  async recharge(userId: string, amountInput: number, processedBy: string, reference?: string) {
    const amount = new Prisma.Decimal(amountInput);
    if (!amount.isFinite() || amount.lte(0)) throw new InternalServerErrorException('Recharge amount must be positive');
    try {
      return await this.inSerializableTransaction(async (tx) => {
        if (reference) {
          const existing = await tx.walletTransaction.findUnique({
            where: { reference },
            include: { wallet: true },
          });
          if (existing) return { wallet: existing.wallet, transaction: existing, replayed: true };
        }

        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet) throw new NotFoundException('Wallet does not exist for this user');

        const updatedWallet = await tx.wallet.update({
          where: { id: wallet.id },
          data: { availableBalance: { increment: amount } },
        });
        const walletTransaction = await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: WalletTransactionType.ADMIN_RECHARGE,
            amount,
            availableDelta: amount,
            heldDelta: new Prisma.Decimal(0),
            reference,
            metadata: { processedBy },
          },
        });
        return { wallet: updatedWallet, transaction: walletTransaction, replayed: false };
      });
    } catch (error) {
      if (reference && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.walletTransaction.findUnique({
          where: { reference },
          include: { wallet: true },
        });
        if (existing) return { wallet: existing.wallet, transaction: existing, replayed: true };
      }
      throw error;
    }
  }

  /** Reserva exactamente `amount`; llamadas repetidas con la misma referencia son idempotentes. */
  async hold(userId: string, reference: string, amountInput: number) {
    const amount = new Prisma.Decimal(amountInput);
    if (!amount.isFinite() || amount.lte(0)) throw new InternalServerErrorException('Hold amount must be positive');
    return this.inSerializableTransaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException('Wallet does not exist for this user');
      const existing = await tx.walletHold.findUnique({ where: { reference } });
      if (existing && existing.walletId !== wallet.id) throw new InternalServerErrorException('Hold reference belongs to another wallet');
      const current = existing?.amount ?? new Prisma.Decimal(0);
      const delta = amount.minus(current);
      if (delta.eq(0)) return { accepted: true, replayed: true };
      if (delta.gt(0)) {
        // Esta única sentencia es el árbitro de dos reservas simultáneas: PostgreSQL
        // bloquea la fila y reevalúa el saldo disponible antes de modificarla.
        const changed = await tx.wallet.updateMany({ where: { id: wallet.id, availableBalance: { gte: delta } }, data: { availableBalance: { decrement: delta }, heldBalance: { increment: delta } } });
        if (!changed.count) throw new ConflictException('Insufficient available ECICoin');
        await tx.walletTransaction.create({ data: { walletId: wallet.id, type: WalletTransactionType.HOLD, amount: delta, availableDelta: delta.negated(), heldDelta: delta, metadata: { reference } } });
      } else {
        const released = delta.negated();
        const changed = await tx.wallet.updateMany({ where: { id: wallet.id, heldBalance: { gte: released } }, data: { availableBalance: { increment: released }, heldBalance: { decrement: released } } });
        if (!changed.count) throw new InternalServerErrorException('Wallet hold invariant was violated');
        await tx.walletTransaction.create({ data: { walletId: wallet.id, type: WalletTransactionType.RELEASE, amount: released, availableDelta: released, heldDelta: released.negated(), metadata: { reference } } });
      }
      await tx.walletHold.upsert({ where: { reference }, create: { walletId: wallet.id, reference, amount }, update: { amount } });
      return { accepted: true, replayed: false };
    });
  }

  /**
   * Libera una reserva vigente cuando la puja que la originó fue superada.
   * `amount` identifica la versión de la puja: un mensaje tardío de una puja
   * anterior no puede liberar una reserva nueva del mismo estudiante y ronda.
   */
  async release(userId: string, reference: string, amountInput: number) {
    const amount = new Prisma.Decimal(amountInput);
    if (!amount.isFinite() || amount.lte(0)) throw new InternalServerErrorException('Release amount must be positive');
    return this.inSerializableTransaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException('Wallet does not exist for this user');
      const hold = await tx.walletHold.findUnique({ where: { reference } });
      if (!hold || !hold.amount.eq(amount)) return { accepted: true, replayed: true };
      if (hold.walletId !== wallet.id) throw new InternalServerErrorException('Hold reference belongs to another wallet');
      const changed = await tx.wallet.updateMany({
        where: { id: wallet.id, heldBalance: { gte: hold.amount } },
        data: { availableBalance: { increment: hold.amount }, heldBalance: { decrement: hold.amount } },
      });
      if (!changed.count) throw new InternalServerErrorException('Wallet hold invariant was violated');
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.RELEASE,
          amount: hold.amount,
          availableDelta: hold.amount,
          heldDelta: hold.amount.negated(),
          metadata: { reference, reason: 'outbid' },
        },
      });
      await tx.walletHold.delete({ where: { reference } });
      return { accepted: true, replayed: false };
    });
  }

  /**
   * Liquida una ronda cerrada (HU-14, HU-29): la reserva del ganador se convierte en debito
   * y cualquier otra reserva de la ronda vuelve al disponible. Una ronda desierta
   * (`winnerId` nulo) solo libera.
   *
   * Es idempotente sin tabla aparte: cada reserva se borra al liquidarla, asi que una
   * reentrega del mismo evento ya no encuentra nada que mover.
   */
  async settleRound(roundId: string, winnerId: string | null) {
    const prefix = `bid:${roundId}:`;
    const winnerReference = winnerId ? `${prefix}${winnerId}` : null;

    return this.inSerializableTransaction(async (tx) => {
      const holds = await tx.walletHold.findMany({ where: { reference: { startsWith: prefix } } });
      let debited: string | null = null;
      let released = 0;

      for (const hold of holds) {
        const won = hold.reference === winnerReference;
        // Lo comprometido sale siempre de `held`; solo lo que se libera vuelve a `available`.
        const changed = await tx.wallet.updateMany({
          where: { id: hold.walletId, heldBalance: { gte: hold.amount } },
          data: won
            ? { heldBalance: { decrement: hold.amount } }
            : { heldBalance: { decrement: hold.amount }, availableBalance: { increment: hold.amount } },
        });
        if (!changed.count) throw new InternalServerErrorException('Wallet hold invariant was violated');

        await tx.walletTransaction.create({
          data: won
            ? {
                walletId: hold.walletId,
                type: WalletTransactionType.DEBIT,
                amount: hold.amount,
                availableDelta: new Prisma.Decimal(0),
                heldDelta: hold.amount.negated(),
                // Unica por ronda: aunque la reserva se recreara, no se cobra dos veces.
                reference: `settle:${roundId}`,
                metadata: { reference: hold.reference, reason: 'round-awarded' },
              }
            : {
                walletId: hold.walletId,
                type: WalletTransactionType.RELEASE,
                amount: hold.amount,
                availableDelta: hold.amount,
                heldDelta: hold.amount.negated(),
                metadata: { reference: hold.reference, reason: 'round-closed' },
              },
        });
        await tx.walletHold.delete({ where: { reference: hold.reference } });

        if (won) debited = hold.amount.toFixed(2);
        else released += 1;
      }

      return { roundId, debited, released };
    });
  }

  async getBalance(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return this.emptyBalance();

    return {
      availableBalance: wallet.availableBalance.toFixed(2),
      heldBalance: wallet.heldBalance.toFixed(2),
      totalBalance: wallet.availableBalance.plus(wallet.heldBalance).toFixed(2),
    };
  }

  async listTransactions(userId: string, page: number, pageSize: number) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return { items: [], page, pageSize, total: 0 };

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);

    return {
      items: transactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        amount: transaction.amount.toFixed(2),
        createdAt: transaction.createdAt,
      })),
      page,
      pageSize,
      total,
    };
  }

  private initialBalance(): Prisma.Decimal {
    const value = this.config.getOrThrow<string>('INITIAL_ECICOIN_BALANCE');
    const balance = new Prisma.Decimal(value);
    if (!balance.isFinite() || balance.isNegative()) {
      throw new InternalServerErrorException('INITIAL_ECICOIN_BALANCE must be a non-negative decimal');
    }
    return balance;
  }

  private emptyBalance() {
    return { availableBalance: '0.00', heldBalance: '0.00', totalBalance: '0.00' };
  }

  /** Reintenta conflictos 40001/P2034 sin repetir efectos fuera de la transacción. */
  private async inSerializableTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const retries = 3;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
        if (!retryable || attempt === retries - 1) throw error;
      }
    }
    throw new InternalServerErrorException('Serializable transaction did not complete');
  }
}
