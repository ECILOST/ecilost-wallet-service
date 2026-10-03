import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { WalletService } from '../wallet/application/wallet.service';
import { ResilientConsumer } from './resilient-consumer';

const KEY = 'wallet.bid-hold.requested.v1';
const QUEUE = 'ecilost.wallet.bid-holds';

@Injectable()
export class BidHoldConsumer extends ResilientConsumer {
  protected readonly logger = new Logger(BidHoldConsumer.name);
  constructor(config: ConfigService, private readonly wallets: WalletService) { super(config, QUEUE, KEY); }
  protected async handle(message: amqp.ConsumeMessage, channel: amqp.Channel) {
    const { replyTo, correlationId } = message.properties;
    try {
      const body = JSON.parse(message.content.toString()) as { userId: string; reference: string; amount: number };
      const result = await this.wallets.hold(body.userId, body.reference, body.amount);
      if (replyTo) channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(result)), { correlationId });
    } catch (error) {
      this.logger.warn(`Bid hold rejected: ${String(error)}`);
      if (replyTo) channel.sendToQueue(replyTo, Buffer.from(JSON.stringify({ accepted: false })), { correlationId });
    } finally { channel.ack(message); }
  }
}
