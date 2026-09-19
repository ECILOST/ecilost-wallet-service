/**
 * Cuerpo de error del servicio, segun RFC 9457 (Problem Details).
 *
 * Es el mismo contrato que publica ecilost-catalog-service, y se copia a proposito en vez de
 * compartirse por un paquete: son servicios independientes y no comparten codigo. Lo que si
 * comparten es la forma, para que el cliente no tenga una rama por servicio.
 */
export interface ProblemDetails {
  /** Identificador estable del tipo de problema. Es lo que conviene ramificar. */
  type: string;
  /** Resumen legible, constante para un mismo `type`. */
  title: string;
  status: number;
  /** Detalle de esta ocurrencia concreta. */
  detail?: string;
  /** Recurso sobre el que ocurrio. */
  instance?: string;
  /** Que campos de la peticion fallaron y por que. */
  errors?: string[];
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Tipos que publica este servicio.
 *
 * Son rutas relativas y no URL absolutas, igual que las de catalog: el cliente las compara
 * como cadenas, y mezclar los dos estilos obliga a recordar cual es cual.
 */
export const ProblemType = {
  VALIDATION: '/problems/validacion',
  UNAUTHENTICATED: '/problems/sin-sesion',
  FORBIDDEN: '/problems/rol-insuficiente',
  /**
   * Se pidio recargar una billetera que no existe.
   *
   * Tiene tipo propio y no el generico porque el cliente puede hacer algo con el: la
   * billetera nace cuando la persona entra por primera vez, asi que la salida es pedirle
   * que entre, no reintentar.
   */
  WALLET_NOT_FOUND: '/problems/billetera-no-encontrada',
  NOT_FOUND: '/problems/recurso-no-encontrado',
  INTERNAL: '/problems/error-interno',
} as const;
