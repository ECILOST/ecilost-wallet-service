import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { WalletService } from '../wallet/application/wallet.service';
import { ResilientConsumer } from './resilient-consumer';

const KEY = 'auction.round.closed.v1';
const QUEUE = 'ecilost.wallet.round-settlements';

/** Lo que wallet necesita del cierre de una ronda que publica auction. */
interface RoundClosed {
  roundId: string;
  winnerId?: string | null;
  /** Eventos anteriores a HU-28 no traen `winnerId`: el lider al cerrar es el ganador. */
  currentBidderId?: string | null;
  /** Precio con que se adjudico la ronda (HU-24). Eventos anteriores no lo traen. */
  winningAmount?: string | null;
}

/**
 * `winningAmount` viaja como texto decimal. Ausente, nulo o invalido: `null`, y se cobra la
 * reserva completa como antes. Descartar el mensaje seria peor: las reservas quedarian
 * retenidas y el objeto vendido sin cobro.
 */
export function parseWinningAmount(value: unknown): Prisma.Decimal | null {
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? new Prisma.Decimal(value) : null;
}

/**
 * Liquida cada ronda que auction cierra: cobra al ganador y libera a los demas (HU-14, HU-29).
 *
 * El mensaje se confirma solo despues de liquidar. Si falla, se reintenta una vez; si vuelve
 * a fallar se descarta con un error en el log, para que un mensaje corrupto no bloquee la
 * cola. La liquidacion es idempotente, asi que reintentar no cobra dos veces.
 */
@Injectable()
export class RoundSettlementConsumer extends ResilientConsumer {
  protected readonly logger = new Logger(RoundSettlementConsumer.name);

  constructor(config: ConfigService, private readonly wallets: WalletService) {
    super(config, QUEUE, KEY);
  }

  protected async handle(message: amqp.ConsumeMessage, channel: amqp.Channel) {
    try {
      const event = JSON.parse(message.content.toString()) as RoundClosed;
      const winnerId = event.winnerId !== undefined ? event.winnerId : (event.currentBidderId ?? null);
      const winningAmount = parseWinningAmount(event.winningAmount);
      if (winningAmount === null && event.winningAmount != null) {
        this.logger.warn(`Ronda ${event.roundId}: winningAmount invalido (${String(event.winningAmount)}); se cobra la reserva completa.`);
      }
      const result = await this.wallets.settleRound(event.roundId, winnerId, winningAmount);
      this.logger.log(
        `Ronda ${result.roundId} liquidada: debito ${result.debited ?? 'ninguno'}, excedente devuelto ${result.refunded ?? 'ninguno'}, ` +
          `${result.released} reservas liberadas.`,
      );
      if (result.shortfall) {
        this.logger.warn(`Ronda ${result.roundId}: la reserva del ganador no alcanzaba el precio adjudicado; faltaron ${result.shortfall}.`);
      }
      channel.ack(message);
    } catch (error) {
      const retry = !message.fields.redelivered;
      this.logger.error(`No se pudo liquidar la ronda (${retry ? 'se reintenta' : 'se descarta'}): ${String(error)}`);
      channel.nack(message, false, retry);
    }
  }
}
