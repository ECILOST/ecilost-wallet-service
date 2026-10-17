import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type * as amqp from 'amqplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

import {
  ATTEMPT_HEADER,
  DEAD_QUEUE,
  MAX_NON_TRANSIENT_ATTEMPTS,
  RETRY_DELAY_MS,
  RETRY_QUEUE,
  RoundSettlementConsumer,
} from './round-settlement.consumer';

const settled = { roundId: 'r', debited: '100.00', refunded: null, shortfall: null, released: 2 };
const conflict = () => new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock', { code: 'P2034', clientVersion: 'test' });

function fakeChannel() {
  return {
    ack: vi.fn(),
    nack: vi.fn(),
    sendToQueue: vi.fn().mockReturnValue(true),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue(undefined),
  };
}

function roundClosed(body: unknown, attempt?: number) {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { redelivered: false },
    properties: { messageId: 'evt-1', contentType: 'application/json', headers: attempt === undefined ? {} : { [ATTEMPT_HEADER]: attempt } },
  } as unknown as amqp.ConsumeMessage;
}

function consumerWith(settleRound: ReturnType<typeof vi.fn>) {
  const consumer = new RoundSettlementConsumer({ getOrThrow: () => 'amqp://test' } as never, { settleRound } as never);
  return consumer as unknown as {
    handle(message: amqp.ConsumeMessage, channel: unknown): Promise<void>;
    setup(channel: unknown): Promise<void>;
  };
}

describe('RoundSettlementConsumer', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  it('declara una cola de reintento que devuelve los mensajes a la cola de liquidacion', async () => {
    const channel = fakeChannel();
    await consumerWith(vi.fn()).setup(channel);
    expect(channel.assertQueue).toHaveBeenCalledWith(RETRY_QUEUE, {
      durable: true,
      arguments: { 'x-message-ttl': RETRY_DELAY_MS, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'ecilost.wallet.round-settlements' },
    });
    expect(channel.assertQueue).toHaveBeenCalledWith(DEAD_QUEUE, { durable: true });
  });

  it('confirma el mensaje solo cuando la ronda quedo liquidada', async () => {
    const settleRound = vi.fn().mockResolvedValue(settled);
    const channel = fakeChannel();
    await consumerWith(settleRound).handle(roundClosed({ roundId: 'r', winnerId: 'u', winningAmount: '100' }), channel);
    expect(settleRound).toHaveBeenCalledWith('r', 'u', new Prisma.Decimal(100));
    expect(channel.ack).toHaveBeenCalledOnce();
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('un conflicto de serializacion manda la ronda a reintento y no la descarta', async () => {
    const channel = fakeChannel();
    const message = roundClosed({ roundId: 'r', winnerId: 'u' });
    await consumerWith(vi.fn().mockRejectedValue(conflict())).handle(message, channel);

    expect(channel.sendToQueue).toHaveBeenCalledWith(RETRY_QUEUE, message.content, expect.objectContaining({
      persistent: true,
      messageId: 'evt-1',
      headers: { [ATTEMPT_HEADER]: 1 },
    }));
    expect(channel.waitForConfirms).toHaveBeenCalledOnce();
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('confirma el original solo despues de que RabbitMQ guardo la copia', async () => {
    const channel = fakeChannel();
    const order: string[] = [];
    channel.waitForConfirms.mockImplementation(async () => { order.push('confirmada'); });
    channel.ack.mockImplementation(() => order.push('ack'));
    await consumerWith(vi.fn().mockRejectedValue(conflict())).handle(roundClosed({ roundId: 'r' }), channel);
    expect(order).toEqual(['confirmada', 'ack']);
  });

  it('los errores de carga se reintentan sin limite, por muchos intentos que lleve', async () => {
    const channel = fakeChannel();
    await consumerWith(vi.fn().mockRejectedValue(conflict())).handle(roundClosed({ roundId: 'r' }, 500), channel);
    expect(channel.sendToQueue).toHaveBeenCalledWith(RETRY_QUEUE, expect.anything(), expect.objectContaining({ headers: { [ATTEMPT_HEADER]: 501 } }));
  });

  it('un error que no es de carga se reintenta y despues de varios intentos se aparta, nunca se pierde', async () => {
    const invariant = new Error('Wallet hold invariant was violated');
    const early = fakeChannel();
    await consumerWith(vi.fn().mockRejectedValue(invariant)).handle(roundClosed({ roundId: 'r' }, MAX_NON_TRANSIENT_ATTEMPTS - 2), early);
    expect(early.sendToQueue).toHaveBeenCalledWith(RETRY_QUEUE, expect.anything(), expect.anything());

    const last = fakeChannel();
    await consumerWith(vi.fn().mockRejectedValue(invariant)).handle(roundClosed({ roundId: 'r' }, MAX_NON_TRANSIENT_ATTEMPTS - 1), last);
    expect(last.sendToQueue).toHaveBeenCalledWith(DEAD_QUEUE, expect.anything(), expect.objectContaining({ headers: { [ATTEMPT_HEADER]: MAX_NON_TRANSIENT_ATTEMPTS } }));
    expect(last.ack).toHaveBeenCalledOnce();
  });

  it('un mensaje ilegible se aparta sin intentar liquidar', async () => {
    const settleRound = vi.fn();
    const channel = fakeChannel();
    await consumerWith(settleRound).handle(roundClosed('{no es json'), channel);
    await consumerWith(settleRound).handle(roundClosed({ winnerId: 'u' }), channel);
    expect(settleRound).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledTimes(2);
    expect(channel.sendToQueue).toHaveBeenNthCalledWith(1, DEAD_QUEUE, expect.anything(), expect.anything());
    expect(channel.sendToQueue).toHaveBeenNthCalledWith(2, DEAD_QUEUE, expect.anything(), expect.anything());
  });

  it('si RabbitMQ no confirma la copia, el original vuelve a la cola en vez de perderse', async () => {
    const channel = fakeChannel();
    channel.waitForConfirms.mockRejectedValue(new Error('channel closed'));
    const message = roundClosed({ roundId: 'r' });
    await consumerWith(vi.fn().mockRejectedValue(conflict())).handle(message, channel);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(message, false, true);
  });
});
