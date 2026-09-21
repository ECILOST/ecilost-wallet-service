import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as amqp from "amqplib";
import { WalletService } from "../wallet/application/wallet.service";

const EXCHANGE = "ecilost.events";
const ROUTING_KEY = "user.created.v1";
const QUEUE = "ecilost.wallet.user-created";
const RETRY_DELAY_MS = 5_000;

interface UserCreatedEvent {
  eventId: string;
  type: "user.created.v1";
  userId: string;
  role: string;
}

/** Crea la billetera de estudiantes nuevos. RabbitMQ puede redeliver; bootstrap es idempotente. */
@Injectable()
export class UserCreatedConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserCreatedConsumer.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;
  private retry?: NodeJS.Timeout;
  private connecting = false;

  constructor(
    private readonly config: ConfigService,
    private readonly wallets: WalletService,
  ) {}

  onModuleInit(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.retry) clearTimeout(this.retry);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.channel) return;
    this.connecting = true;
    try {
      this.connection = await amqp.connect(
        this.config.getOrThrow<string>("RABBITMQ_URL"),
      );
      this.connection.on("error", () => this.resetAndRetry());
      this.connection.on("close", () => this.resetAndRetry());
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(EXCHANGE, "topic", { durable: true });
      await this.channel.assertQueue(QUEUE, { durable: true });
      await this.channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
      await this.channel.prefetch(10);
      await this.channel.consume(
        QUEUE,
        (message) => void this.handle(message),
        { noAck: false },
      );
      this.logger.log("Consumidor UserCreated conectado a RabbitMQ");
    } catch (error) {
      this.logger.warn(`No fue posible conectar a RabbitMQ: ${String(error)}`);
      this.resetAndRetry();
    } finally {
      this.connecting = false;
    }
  }

  private async handle(message: amqp.ConsumeMessage | null): Promise<void> {
    if (!message || !this.channel) return;
    try {
      const event = JSON.parse(
        message.content.toString("utf8"),
      ) as UserCreatedEvent;
      if (event.type !== ROUTING_KEY || !event.eventId || !event.userId) {
        this.logger.error(
          "Mensaje UserCreated invalido; se descarta sin reintento",
        );
        this.channel.nack(message, false, false);
        return;
      }

      // La emision inicial pertenece a estudiantes. Los usuarios STAFF no reciben ECICoin.
      if (event.role === "STUDENT") await this.wallets.bootstrap(event.userId);
      this.channel.ack(message);
    } catch (error) {
      this.logger.warn(
        `No fue posible procesar UserCreated; RabbitMQ lo reintentara: ${String(error)}`,
      );
      this.channel.nack(message, false, true);
    }
  }

  private resetAndRetry(): void {
    this.channel = undefined;
    this.connection = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), RETRY_DELAY_MS);
  }
}
