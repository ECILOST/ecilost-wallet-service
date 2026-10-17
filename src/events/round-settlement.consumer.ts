import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { isTransientDatabaseError } from '../common/errors/transient-error';
import { WalletService } from '../wallet/application/wallet.service';
import { ResilientConsumer } from './resilient-consumer';

const KEY = 'auction.round.closed.v1';
const QUEUE = 'ecilost.wallet.round-settlements';
/** Espera de un reintento: al vencer, RabbitMQ devuelve el mensaje a `QUEUE`. */
export const RETRY_QUEUE = `${QUEUE}.retry`;
/** Mensajes que necesitan a una persona. Se reprocesan moviendolos de vuelta a `QUEUE`. */
export const DEAD_QUEUE = `${QUEUE}.dead`;
export const RETRY_DELAY_MS = 1_000;
export const ATTEMPT_HEADER = 'x-settlement-attempt';
/** Intentos ante un error que no es de carga (p. ej. un invariante violado) antes de apartarlo. */
export const MAX_NON_TRANSIENT_ATTEMPTS = 5;

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
 * Una liquidacion nunca se descarta. Antes se reintentaba una vez y luego se perdia: bajo
 * carga `settleRound` choca con las reservas de otras rondas y la ronda quedaba sin cobrar
 * al ganador y con las reservas de los demas retenidas para siempre.
 *
 * - Si falla, el mensaje pasa a `RETRY_QUEUE`, que lo devuelve a la cola en `RETRY_DELAY_MS`.
 *   El original se confirma solo cuando RabbitMQ ya guardo la copia (canal con
 *   confirmaciones); si el proceso cae antes, RabbitMQ lo reentrega.
 * - Los errores de carga o de conexion se reintentan sin limite: la ronda se liquida en
 *   cuanto la base lo permita.
 * - Un mensaje ilegible, o uno que falla `MAX_NON_TRANSIENT_ATTEMPTS` veces por otro motivo,
 *   va a `DEAD_QUEUE` con un error en el log en vez de reintentarse para siempre.
 *
 * La liquidacion es idempotente, asi que reintentar no cobra dos veces.
 */
@Injectable()
export class RoundSettlementConsumer extends ResilientConsumer {
  protected readonly logger = new Logger(RoundSettlementConsumer.name);

  constructor(config: ConfigService, private readonly wallets: WalletService) {
    super(config, QUEUE, KEY, { confirm: true });
  }

  protected async setup(channel: amqp.Channel) {
    await channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: { 'x-message-ttl': RETRY_DELAY_MS, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': QUEUE },
    });
    await channel.assertQueue(DEAD_QUEUE, { durable: true });
  }

  protected async handle(message: amqp.ConsumeMessage, channel: amqp.Channel) {
    let event: RoundClosed;
    try {
      event = JSON.parse(message.content.toString()) as RoundClosed;
      if (typeof event?.roundId !== 'string' || !event.roundId) throw new Error('falta roundId');
    } catch (error) {
      this.logger.error(`Cierre de ronda ilegible; se aparta en ${DEAD_QUEUE}: ${String(error)}`);
      await this.forward(message, channel, DEAD_QUEUE, 0);
      return;
    }

    const failures = Number(message.properties.headers?.[ATTEMPT_HEADER] ?? 0) + 1;
    try {
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
      if (!isTransientDatabaseError(error) && failures >= MAX_NON_TRANSIENT_ATTEMPTS) {
        this.logger.error(`Ronda ${event.roundId} sin liquidar tras ${failures} intentos; se aparta en ${DEAD_QUEUE}: ${String(error)}`);
        await this.forward(message, channel, DEAD_QUEUE, failures);
        return;
      }
      this.logger.warn(`Ronda ${event.roundId} sin liquidar (intento ${failures}); se reintenta en ${RETRY_DELAY_MS} ms: ${String(error)}`);
      await this.forward(message, channel, RETRY_QUEUE, failures);
    }
  }

  /**
   * Mueve el mensaje a `queue`: publica la copia, espera a que RabbitMQ la confirme y solo
   * entonces confirma el original. Si la copia no se guarda, el original vuelve a la cola.
   */
  private async forward(message: amqp.ConsumeMessage, channel: amqp.Channel, queue: string, failures: number) {
    try {
      const { headers, contentType, messageId } = message.properties;
      channel.sendToQueue(queue, message.content, {
        persistent: true,
        contentType,
        messageId,
        headers: { ...headers, [ATTEMPT_HEADER]: failures },
      });
      await (channel as amqp.ConfirmChannel).waitForConfirms();
      channel.ack(message);
    } catch (error) {
      this.logger.error(`No se pudo mover la liquidacion a ${queue}; vuelve a la cola: ${String(error)}`);
      channel.nack(message, false, true);
    }
  }
}
