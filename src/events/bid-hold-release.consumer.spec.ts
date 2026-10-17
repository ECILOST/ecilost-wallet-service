import { ConflictException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type * as amqp from 'amqplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

import { BidHoldConsumer } from './bid-hold.consumer';
import { BidReleaseConsumer } from './bid-release.consumer';
import { rejectionReason } from './rejection-reason';

const request = () => ({
  content: Buffer.from(JSON.stringify({ userId: 'u', reference: 'bid:r:u', amount: 100 })),
  properties: { replyTo: 'reply-queue', correlationId: 'c-1' },
}) as unknown as amqp.ConsumeMessage;

function run(Consumer: typeof BidHoldConsumer | typeof BidReleaseConsumer, wallets: object) {
  const channel = { sendToQueue: vi.fn(), ack: vi.fn() };
  const consumer = new Consumer({ getOrThrow: () => 'amqp://test' } as never, wallets as never) as unknown as {
    handle(message: amqp.ConsumeMessage, channel: unknown): Promise<void>;
  };
  return consumer.handle(request(), channel).then(() => ({
    reply: JSON.parse((channel.sendToQueue.mock.calls[0][1] as Buffer).toString()),
    options: channel.sendToQueue.mock.calls[0][2],
    channel,
  }));
}

const conflict = new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: 'test' });

describe('Motivo de rechazo de reservas y liberaciones', () => {
  beforeEach(() => vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));

  it('clasifica cada error en un motivo que auction puede distinguir', () => {
    expect(rejectionReason(new ConflictException('Insufficient available ECICoin'))).toBe('INSUFFICIENT_FUNDS');
    expect(rejectionReason(new NotFoundException('Wallet does not exist for this user'))).toBe('WALLET_NOT_FOUND');
    expect(rejectionReason(conflict)).toBe('RETRY');
    expect(rejectionReason(new Prisma.PrismaClientKnownRequestError('timeout', { code: 'P2028', clientVersion: 'test' }))).toBe('RETRY');
    expect(rejectionReason(new InternalServerErrorException('Wallet hold invariant was violated'))).toBe('ERROR');
    expect(rejectionReason(new SyntaxError('Unexpected token'))).toBe('ERROR');
  });

  it('una reserva aceptada responde igual que antes', async () => {
    const { reply, options, channel } = await run(BidHoldConsumer, { hold: vi.fn().mockResolvedValue({ accepted: true, replayed: false }) });
    expect(reply).toEqual({ accepted: true, replayed: false });
    expect(options).toEqual({ correlationId: 'c-1' });
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('sin saldo suficiente la reserva responde INSUFFICIENT_FUNDS', async () => {
    const { reply } = await run(BidHoldConsumer, { hold: vi.fn().mockRejectedValue(new ConflictException('Insufficient available ECICoin')) });
    expect(reply).toEqual({ accepted: false, reason: 'INSUFFICIENT_FUNDS' });
  });

  it('si wallet estaba ocupada la reserva responde RETRY, no "saldo insuficiente"', async () => {
    const { reply, channel } = await run(BidHoldConsumer, { hold: vi.fn().mockRejectedValue(conflict) });
    expect(reply).toEqual({ accepted: false, reason: 'RETRY' });
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('la liberacion tambien informa el motivo', async () => {
    const busy = await run(BidReleaseConsumer, { release: vi.fn().mockRejectedValue(conflict) });
    expect(busy.reply).toEqual({ accepted: false, reason: 'RETRY' });
    const missing = await run(BidReleaseConsumer, { release: vi.fn().mockRejectedValue(new NotFoundException('Wallet does not exist for this user')) });
    expect(missing.reply).toEqual({ accepted: false, reason: 'WALLET_NOT_FOUND' });
  });
});
