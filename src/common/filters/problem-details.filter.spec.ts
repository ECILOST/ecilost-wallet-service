import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { PROBLEM_CONTENT_TYPE, ProblemType } from '../http/problem-details';
import { ProblemDetailsFilter } from './problem-details.filter';

/**
 * El filtro es lo unico que decide como se ve un error desde fuera del servicio, asi que lo
 * que se prueba es exactamente eso: el cuerpo que sale, no el que entra.
 */
function capture(exception: unknown, url = '/wallet/me') {
  const json = vi.fn();
  const response = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    json,
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ url, method: 'GET' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new ProblemDetailsFilter().catch(exception, host);

  return {
    body: json.mock.calls[0]?.[0] as Record<string, unknown>,
    status: response.status.mock.calls[0]?.[0] as number,
    contentType: response.type.mock.calls[0]?.[0] as string,
  };
}

describe('ProblemDetailsFilter', () => {
  it('responde con el content type de Problem Details, no con JSON a secas', () => {
    const { contentType } = capture(new NotFoundException('nope'));

    expect(contentType).toBe(PROBLEM_CONTENT_TYPE);
  });

  it('traduce la falta de sesion', () => {
    const { body, status } = capture(
      new UnauthorizedException('Bearer token is required'),
    );

    expect(status).toBe(401);
    expect(body).toMatchObject({
      type: ProblemType.UNAUTHENTICATED,
      status: 401,
      detail: 'Bearer token is required',
      instance: '/wallet/me',
    });
  });

  it('traduce el rol insuficiente', () => {
    const { body } = capture(new ForbiddenException());

    expect(body.type).toBe(ProblemType.FORBIDDEN);
  });

  it('distingue la billetera que no existe de un 404 cualquiera', () => {
    // El cliente puede actuar sobre este: la billetera nace cuando la persona entra, asi
    // que la salida es pedirle que entre, no reintentar.
    const billetera = capture(
      new NotFoundException('Wallet does not exist for this user'),
    );
    const otro = capture(new NotFoundException('Cannot GET /wallet/nada'));

    expect(billetera.body.type).toBe(ProblemType.WALLET_NOT_FOUND);
    expect(otro.body.type).toBe(ProblemType.NOT_FOUND);
  });

  it('pone en `errors` cada regla que incumplio la peticion', () => {
    // Es la forma que da ValidationPipe cuando rechaza varios campos. Separarlos permite al
    // cliente ponerlos debajo de su casilla en vez de en un parrafo.
    const { body } = capture(
      new BadRequestException([
        'amount must be a positive number',
        'reference must be shorter than or equal to 128 characters',
      ]),
    );

    expect(body.type).toBe(ProblemType.VALIDATION);
    expect(body.errors).toHaveLength(2);
    expect(body.detail).toBe('Uno o mas campos no cumplen el contrato.');
  });

  it('con un solo fallo de validacion, ese fallo es el detalle', () => {
    const { body } = capture(
      new BadRequestException(['amount must be a positive number']),
    );

    expect(body.detail).toBe('amount must be a positive number');
    expect(body.errors).toEqual(['amount must be a positive number']);
  });

  it('no filtra el detalle tecnico de un fallo inesperado', () => {
    // El filtro escribe el fallo en el log, que es justamente lo que se quiere. Se silencia
    // aqui para que la salida de las pruebas no parezca un error de verdad.
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});

    // Lo que se rompio va al log; al cliente solo le llega que fallo el servidor.
    const { body, status } = capture(
      new Error('connect ECONNREFUSED 127.0.0.1:5435'),
    );

    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();

    expect(status).toBe(500);
    expect(body.type).toBe(ProblemType.INTERNAL);
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });
});
