import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type * as amqp from 'amqplib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ connect }));

import { ResilientConsumer } from './resilient-consumer';

class TestConsumer extends ResilientConsumer {
  protected readonly logger = new Logger('TestConsumer');
  readonly handled: amqp.ConsumeMessage[] = [];
  constructor() {
    super({ getOrThrow: () => 'amqp://test' } as never, 'test.queue', 'test.key');
  }
  protected async handle(message: amqp.ConsumeMessage) {
    this.handled.push(message);
  }
}

function fakeConnection() {
  const connection = Object.assign(new EventEmitter(), {
    channel: {
      assertExchange: vi.fn(),
      assertQueue: vi.fn(),
      bindQueue: vi.fn(),
      consume: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    },
    createChannel: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  });
  connection.createChannel.mockResolvedValue(connection.channel);
  return connection;
}

describe('ResilientConsumer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connect.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('no tumba el arranque si RabbitMQ no responde: reintenta hasta conectar', async () => {
    const connection = fakeConnection();
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(connection);
    const consumer = new TestConsumer();

    consumer.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.channel.consume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connection.channel.bindQueue).toHaveBeenCalledWith('test.queue', 'ecilost.events', 'test.key');
    expect(connection.channel.consume).toHaveBeenCalledWith('test.queue', expect.any(Function));
    await consumer.onModuleDestroy();
  });

  it('si la conexion se cae despues, vuelve a consumir sin reiniciar el servicio', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const consumer = new TestConsumer();

    consumer.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.channel.consume).toHaveBeenCalledTimes(1);

    first.emit('close');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.channel.consume).toHaveBeenCalledTimes(1);
    await consumer.onModuleDestroy();
  });

  it('al apagarse el servicio deja de reintentar', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const consumer = new TestConsumer();

    consumer.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
