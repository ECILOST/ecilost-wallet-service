import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WalletTransactionType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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

  private initialBalance(): Prisma.Decimal {
    const value = this.config.getOrThrow<string>('INITIAL_ECICOIN_BALANCE');
    const balance = new Prisma.Decimal(value);
    if (!balance.isFinite() || balance.isNegative()) {
      throw new InternalServerErrorException('INITIAL_ECICOIN_BALANCE must be a non-negative decimal');
    }
    return balance;
  }
}
