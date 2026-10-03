import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

const EXCHANGE = 'ecilost.events';
const RETRY_DELAY_MS = 5_000;

/**
 * Consumidor de `ecilost.events` que sobrevive a RabbitMQ.
 *
 * Conectar una sola vez en `onModuleInit` tenia dos fallos: si RabbitMQ no respondia al
 * arrancar, el servicio entero no levantaba; y si la conexion se caia despues (CloudAMQP
 * reinicia, un corte de red), el consumidor quedaba muerto sin avisar. Las reservas, las
 * liberaciones y la liquidacion de rondas dejaban de procesarse hasta reiniciar el
 * contenedor, y a quien perdia no se le devolvian sus ECICoin.
 *
 * Aqui la conexion se reintenta cada pocos segundos, al arrancar y cada vez que se cae. Los
 * mensajes pendientes esperan en la cola durable mientras tanto.
 */
export abstract class ResilientConsumer implements OnModuleInit, OnModuleDestroy {
  protected abstract readonly logger: Logger;
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;
  private retry?: NodeJS.Timeout;
  private connecting = false;
  private stopped = false;

  protected constructor(
    private readonly config: ConfigService,
    private readonly queue: string,
    private readonly routingKey: string,
  ) {}

  /**
   * Procesa un mensaje. Debe confirmarlo (`ack`/`nack`) sobre `channel`, que es el canal
   * por el que llego: tras una reconexion el anterior ya no sirve.
   */
  protected abstract handle(message: amqp.ConsumeMessage, channel: amqp.Channel): Promise<void>;

  onModuleInit(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.channel) return;
    this.connecting = true;
    try {
      const connection = await amqp.connect(this.config.getOrThrow<string>('RABBITMQ_URL'));
      this.connection = connection;
      connection.on('error', (error: unknown) => this.logger.warn(`Error en la conexion con RabbitMQ: ${String(error)}`));
      connection.on('close', () => this.resetAndRetry());
      const channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      await channel.assertQueue(this.queue, { durable: true });
      await channel.bindQueue(this.queue, EXCHANGE, this.routingKey);
      await channel.consume(this.queue, (message) => {
        if (message) void this.handle(message, channel);
      });
      this.channel = channel;
      this.logger.log(`Consumiendo ${this.routingKey} desde ${this.queue}`);
    } catch (error) {
      this.logger.warn(`No fue posible conectar a RabbitMQ; se reintenta en ${RETRY_DELAY_MS / 1000} s: ${String(error)}`);
      await this.connection?.close().catch(() => undefined);
      this.resetAndRetry();
    } finally {
      this.connecting = false;
    }
  }

  private resetAndRetry(): void {
    this.channel = undefined;
    this.connection = undefined;
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), RETRY_DELAY_MS);
  }
}
