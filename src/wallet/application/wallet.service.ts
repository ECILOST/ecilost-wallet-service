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
    try {
      return await this.prisma.$transaction(async (tx) => {
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
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException('Wallet does not exist for this user');
      const existing = await tx.walletHold.findUnique({ where: { reference } });
      if (existing && existing.walletId !== wallet.id) throw new InternalServerErrorException('Hold reference belongs to another wallet');
      const current = existing?.amount ?? new Prisma.Decimal(0);
      const delta = amount.minus(current);
      if (delta.eq(0)) return { accepted: true, replayed: true };
      if (delta.gt(0)) {
        const changed = await tx.wallet.updateMany({ where: { id: wallet.id, availableBalance: { gte: delta } }, data: { availableBalance: { decrement: delta }, heldBalance: { increment: delta } } });
        if (!changed.count) throw new ConflictException('Insufficient available ECICoin');
        await tx.walletTransaction.create({ data: { walletId: wallet.id, type: WalletTransactionType.HOLD, amount: delta, availableDelta: delta.negated(), heldDelta: delta, metadata: { reference } } });
      } else {
        const released = delta.negated();
        await tx.wallet.update({ where: { id: wallet.id }, data: { availableBalance: { increment: released }, heldBalance: { decrement: released } } });
        await tx.walletTransaction.create({ data: { walletId: wallet.id, type: WalletTransactionType.RELEASE, amount: released, availableDelta: released, heldDelta: released.negated(), metadata: { reference } } });
      }
      await tx.walletHold.upsert({ where: { reference }, create: { walletId: wallet.id, reference, amount }, update: { amount } });
      return { accepted: true, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
}
