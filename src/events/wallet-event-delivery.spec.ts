import { EventEmitter } from 'node:events';
import type { ConfigService } from '@nestjs/config';
import type { Channel, ConsumeMessage } from 'amqplib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletService } from '../wallet/application/wallet.service';
import { BalanceQueryConsumer } from './balance-query.consumer';
import { UserCreatedConsumer } from './user-created.consumer';

const connect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ connect }));

const config = { getOrThrow: () => 'amqp://test' } as unknown as ConfigService;
const event = { eventId: 'event-1', type: 'user.created.v1', userId: 'student-id', role: 'STUDENT' };

function broker() {
  const channel = {
    assertExchange: vi.fn(), assertQueue: vi.fn(), bindQueue: vi.fn(), prefetch: vi.fn(),
    consume: vi.fn(), ack: vi.fn(), nack: vi.fn(), sendToQueue: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const connection = Object.assign(new EventEmitter(), {
    createChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return { channel, connection };
}

function delivery(body: unknown): ConsumeMessage {
  return {
    properties: { replyTo: 'replies', correlationId: 'query-1' },
    content: Buffer.from(JSON.stringify(body)),
  } as ConsumeMessage;
}

describe('UserCreatedConsumer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connect.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('subscribes and grants the initial wallet only to students', async () => {
    const { channel, connection } = broker();
    connect.mockResolvedValue(connection);
    const bootstrap = vi.fn();
    const consumer = new UserCreatedConsumer(config, { bootstrap } as unknown as WalletService);
    consumer.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(channel.bindQueue).toHaveBeenCalledWith('ecilost.wallet.user-created', 'ecilost.events', 'user.created.v1');

      const handle: (message: ConsumeMessage | null) => void = channel.consume.mock.calls[0][1];
      const student = delivery(event);
      const staff = delivery({ ...event, userId: 'staff-id', role: 'STAFF' });
      const incomplete = delivery({ type: event.type });
      handle(null);
      handle(student);
      handle(staff);
      handle(incomplete);
      await vi.advanceTimersByTimeAsync(0);

      expect(bootstrap).toHaveBeenCalledWith('student-id');
      expect(bootstrap).toHaveBeenCalledTimes(1);
      expect(channel.ack).toHaveBeenCalledTimes(2);
      expect(channel.ack).toHaveBeenCalledWith(student);
      expect(channel.ack).toHaveBeenCalledWith(staff);
      expect(channel.nack).toHaveBeenCalledWith(incomplete, false, false);
      expect(channel.nack).toHaveBeenCalledTimes(1);
    } finally {
      await consumer.onModuleDestroy();
    }
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('reconnects after broker failure and asks for redelivery when bootstrap fails', async () => {
    const { channel, connection } = broker();
    connect.mockRejectedValueOnce(new Error('broker unavailable')).mockResolvedValue(connection);
    const bootstrap = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const consumer = new UserCreatedConsumer(config, { bootstrap } as unknown as WalletService);
    consumer.onModuleInit();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(channel.consume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(connect).toHaveBeenCalledTimes(2);
      const message = delivery(event);
      channel.consume.mock.calls[0][1](message);
      await vi.advanceTimersByTimeAsync(0);
      expect(channel.nack).toHaveBeenCalledWith(message, false, true);
      expect(channel.ack).not.toHaveBeenCalled();
    } finally {
      await consumer.onModuleDestroy();
    }
  });
});

class BalanceConsumer extends BalanceQueryConsumer {
  public override handle(message: ConsumeMessage, channel: Channel) {
    return super.handle(message, channel);
  }
}

describe('BalanceQueryConsumer', () => {
  it.each([true, false])('replies to a balance query and acknowledges it (success: %s)', async (success) => {
    const { channel } = broker();
    const getBalance = vi.fn();
    if (success) getBalance.mockResolvedValue({ availableBalance: 450 });
    else getBalance.mockRejectedValue(new Error('balance unavailable'));
    const consumer = new BalanceConsumer(config, { getBalance } as unknown as WalletService);
    const message = delivery({ userId: 'student-id' });

    await consumer.handle(message, channel as unknown as Channel);

    expect(getBalance).toHaveBeenCalledWith('student-id');
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'replies',
      Buffer.from(JSON.stringify(success ? { accepted: true, availableBalance: 450 } : { accepted: false })),
      { correlationId: 'query-1' },
    );
    expect(channel.ack).toHaveBeenCalledWith(message);
  });
});
