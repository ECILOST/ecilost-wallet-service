import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  PROBLEM_CONTENT_TYPE,
  ProblemType,
  type ProblemDetails,
} from '../http/problem-details';

/**
 * Lo poco que este filtro necesita de Express, declarado aqui con los campos que usa.
 *
 * Se hace asi y no importando los tipos de `express` porque el servicio no tiene
 * `@types/express` instalado, y meter una dependencia de tipos entera para cinco miembros
 * seria desproporcionado. Es la misma decision que toma ecilost-catalog-service con Multer.
 */
interface HttpRequestLike {
  url: string;
  method: string;
}

interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  type(contentType: string): HttpResponseLike;
  json(body: unknown): void;
}

/**
 * Traduce cualquier excepcion al cuerpo de error publicado por el servicio.
 *
 * Va en un filtro global y no en cada controlador para que un endpoint nuevo no pueda
 * responder un formato distinto por olvido. Sin el, Nest responde su forma por defecto
 * (`{ statusCode, message, error }`), que es una tercera forma de error en una plataforma
 * donde catalog ya habla RFC 9457 y auth habla RFC 6749: el cliente acaba con una rama por
 * servicio en vez de una sola lectura.
 *
 * El detalle tecnico de un 500 se queda en el log. Al cliente solo le llega que fallo del
 * lado del servidor.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();

    const problem = this.toProblem(exception, request.url);

    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${request.method} ${request.url}`, asStack(exception));
    }

    response.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetails {
    if (!(exception instanceof HttpException)) {
      return {
        type: ProblemType.INTERNAL,
        title: 'Error interno del servicio',
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        instance,
      };
    }

    const status = exception.getStatus();
    const messages = extractMessages(exception.getResponse());

    // ValidationPipe entrega un mensaje por regla incumplida. Se publican tal cual, en
    // `errors`, que es donde el cliente los busca para ponerlos debajo de su campo.
    if (status === HttpStatus.BAD_REQUEST && messages.length > 0) {
      return {
        type: ProblemType.VALIDATION,
        title: 'La peticion no es valida',
        status,
        detail:
          messages.length === 1
            ? messages[0]
            : 'Uno o mas campos no cumplen el contrato.',
        instance,
        errors: messages,
      };
    }

    return {
      type: typeFor(status, messages),
      title: titleFor(status),
      status,
      detail: messages[0] ?? exception.message,
      instance,
    };
  }
}

function extractMessages(body: unknown): string[] {
  if (typeof body === 'string') return [body];
  if (typeof body !== 'object' || body === null) return [];

  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String);
  if (typeof message === 'string') return [message];
  return [];
}

/**
 * El 404 de una billetera que no existe se separa del 404 corriente: el cliente puede
 * actuar sobre el, y para reconocerlo solo hace falta mirar lo que dijo el caso de uso.
 */
function typeFor(status: number, messages: string[]): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return ProblemType.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return ProblemType.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return messages.some((message) => message.includes('Wallet'))
        ? ProblemType.WALLET_NOT_FOUND
        : ProblemType.NOT_FOUND;
    case HttpStatus.BAD_REQUEST:
      return ProblemType.VALIDATION;
    default:
      return ProblemType.INTERNAL;
  }
}

function titleFor(status: number): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'Se requiere iniciar sesion';
    case HttpStatus.FORBIDDEN:
      return 'Tu rol no permite esta operacion';
    case HttpStatus.NOT_FOUND:
      return 'El recurso no existe';
    case HttpStatus.BAD_REQUEST:
      return 'La peticion no es valida';
    default:
      return 'Error interno del servicio';
  }
}

function asStack(exception: unknown): string {
  return exception instanceof Error
    ? (exception.stack ?? exception.message)
    : String(exception);
}
