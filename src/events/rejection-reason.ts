import { ConflictException, NotFoundException } from '@nestjs/common';
import { isTransientDatabaseError } from '../common/errors/transient-error';

/**
 * Por que wallet no acepto una reserva o liberacion. Viaja junto a `accepted: false` para que
 * auction distinga "no te alcanza" de "wallet estaba ocupado, intenta de nuevo"; quien solo
 * mira `accepted` sigue funcionando igual.
 */
export type RejectionReason = 'INSUFFICIENT_FUNDS' | 'WALLET_NOT_FOUND' | 'RETRY' | 'ERROR';

export function rejectionReason(error: unknown): RejectionReason {
  if (error instanceof ConflictException) return 'INSUFFICIENT_FUNDS';
  if (error instanceof NotFoundException) return 'WALLET_NOT_FOUND';
  if (isTransientDatabaseError(error)) return 'RETRY';
  return 'ERROR';
}
