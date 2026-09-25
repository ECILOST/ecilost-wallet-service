import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { WalletService } from '../wallet/application/wallet.service';

const EXCHANGE = 'ecilost.events';
const KEY = 'auction.round.closed.v1';
const QUEUE = 'ecilost.wallet.round-settlements';

/** Lo que wallet necesita del cierre de una ronda que publica auction. */
interface RoundClosed {
  roundId: string;
  winnerId?: string | null;
  /** Eventos anteriores a HU-28 no traen `winnerId`: el lider al cerrar es el ganador. */
  currentBidderId?: string | null;
}

/**
 * Liquida cada ronda que auction cierra: cobra al ganador y libera a los demas (HU-14, HU-29).
 *
 * El mensaje se confirma solo despues de liquidar. Si falla, se reintenta una vez; si vuelve
 * a fallar se descarta con un error en el log, para que un mensaje corrupto no bloquee la
 * cola. La liquidacion es idempotente, asi que reintentar no cobra dos veces.
 */
@Injectable()
export class RoundSettlementConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoundSettlementConsumer.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;

  constructor(private readonly config: ConfigService, private readonly wallets: WalletService) {}

  async onModuleInit() {
    this.connection = await amqp.connect(this.config.getOrThrow<string>('RABBITMQ_URL'));
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await this.channel.assertQueue(QUEUE, { durable: true });
    await this.channel.bindQueue(QUEUE, EXCHANGE, KEY);
    await this.channel.consume(QUEUE, (message) => void this.handle(message));
  }

  async onModuleDestroy() {
    await this.channel?.close();
    await this.connection?.close();
  }

  private async handle(message: amqp.ConsumeMessage | null) {
    if (!message || !this.channel) return;
    try {
      const event = JSON.parse(message.content.toString()) as RoundClosed;
      const winnerId = event.winnerId !== undefined ? event.winnerId : (event.currentBidderId ?? null);
      const result = await this.wallets.settleRound(event.roundId, winnerId);
      this.logger.log(`Ronda ${result.roundId} liquidada: debito ${result.debited ?? 'ninguno'}, ${result.released} reservas liberadas.`);
      this.channel.ack(message);
    } catch (error) {
      const retry = !message.fields.redelivered;
      this.logger.error(`No se pudo liquidar la ronda (${retry ? 'se reintenta' : 'se descarta'}): ${String(error)}`);
      this.channel.nack(message, false, retry);
    }
  }
}
