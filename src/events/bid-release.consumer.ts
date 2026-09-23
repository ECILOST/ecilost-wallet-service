import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { WalletService } from '../wallet/application/wallet.service';

const EXCHANGE = 'ecilost.events';
const KEY = 'wallet.bid-release.requested.v1';
const QUEUE = 'ecilost.wallet.bid-releases';

@Injectable()
export class BidReleaseConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BidReleaseConsumer.name);
  private connection?: amqp.ChannelModel; private channel?: amqp.Channel;
  constructor(private readonly config: ConfigService, private readonly wallets: WalletService) {}
  async onModuleInit() {
    this.connection = await amqp.connect(this.config.getOrThrow<string>('RABBITMQ_URL'));
    this.channel = await this.connection.createChannel(); await this.channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await this.channel.assertQueue(QUEUE, { durable: true }); await this.channel.bindQueue(QUEUE, EXCHANGE, KEY);
    await this.channel.consume(QUEUE, (message) => void this.handle(message));
  }
  async onModuleDestroy() { await this.channel?.close(); await this.connection?.close(); }
  private async handle(message: amqp.ConsumeMessage | null) {
    if (!message || !this.channel) return;
    const { replyTo, correlationId } = message.properties;
    try {
      const body = JSON.parse(message.content.toString()) as { userId: string; reference: string; amount: number };
      const result = await this.wallets.release(body.userId, body.reference, body.amount);
      if (replyTo) this.channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(result)), { correlationId });
    } catch (error) {
      this.logger.warn(`Bid release rejected: ${String(error)}`);
      if (replyTo) this.channel.sendToQueue(replyTo, Buffer.from(JSON.stringify({ accepted: false })), { correlationId });
    } finally { this.channel.ack(message); }
  }
}
