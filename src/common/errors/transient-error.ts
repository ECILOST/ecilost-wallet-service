import { Prisma } from '@prisma/client';

/**
 * Codigos de Prisma que indican que la operacion no llego a aplicarse y puede repetirse tal
 * cual: conflicto de serializacion o deadlock (P2034), transaccion que no inicio o vencio
 * (P2028), pool de conexiones agotado (P2024) y conexion con la base perdida (P1xxx).
 */
const TRANSIENT_CODES = new Set(['P2034', 'P2028', 'P2024', 'P1001', 'P1002', 'P1008', 'P1017']);

/** El error se debe a carga o a la conexion, no a los datos: reintentar puede resolverlo. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return TRANSIENT_CODES.has(error.code);
  return error instanceof Prisma.PrismaClientInitializationError;
}
