import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { WalletService } from '../wallet/application/wallet.service';
import { ResilientConsumer } from './resilient-consumer';

const KEY = 'wallet.balance.requested.v1';
const QUEUE = 'ecilost.wallet.balance-queries';

/**
 * Consulta de saldo para Auction (HU-22): antes de aceptar el limite de una puja automatica
 * comprueba que no pase del saldo disponible. Solo lee; no reserva ni mueve nada.
 */
@Injectable()
export class BalanceQueryConsumer extends ResilientConsumer {
  protected readonly logger = new Logger(BalanceQueryConsumer.name);
  constructor(config: ConfigService, private readonly wallets: WalletService) { super(config, QUEUE, KEY); }
  protected async handle(message: amqp.ConsumeMessage, channel: amqp.Channel) {
    const { replyTo, correlationId } = message.properties;
    try {
      const body = JSON.parse(message.content.toString()) as { userId: string };
      const balance = await this.wallets.getBalance(body.userId);
      if (replyTo) channel.sendToQueue(replyTo, Buffer.from(JSON.stringify({ accepted: true, availableBalance: balance.availableBalance })), { correlationId });
    } catch (error) {
      this.logger.warn(`Balance query failed: ${String(error)}`);
      if (replyTo) channel.sendToQueue(replyTo, Buffer.from(JSON.stringify({ accepted: false })), { correlationId });
    } finally { channel.ack(message); }
  }
}
