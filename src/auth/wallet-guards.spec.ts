import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from './authenticated-user.interface';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ROLES_KEY } from './roles.decorator';
import { RolesGuard } from './roles.guard';

const jwtVerify = vi.hoisted(() => vi.fn());
vi.mock('jose', () => ({ jwtVerify, createRemoteJWKSet: () => vi.fn() }));

function http(authorization?: string, user?: AuthenticatedUser) {
  const request = { headers: { authorization }, user };
  function handler() {}
  class Controller {}
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
  return { request, context, handler };
}

describe('JwtAuthGuard', () => {
  const settings: Record<string, string> = {
    AUTH_JWKS_URL: 'https://auth.example.test/jwks',
    AUTH_ISSUER: 'wallet-issuer',
    AUTH_AUDIENCE: 'wallet-audience',
  };
  const config = { getOrThrow: (key: string) => settings[key] } as unknown as ConfigService;
  beforeEach(() => jwtVerify.mockReset());

  it('validates the configured issuer and audience and sets the request user', async () => {
    const { context, request } = http('Bearer student-token');
    jwtVerify.mockResolvedValue({ payload: { sub: 'student-id', role: 'STUDENT' } });

    await expect(new JwtAuthGuard(config).canActivate(context)).resolves.toBe(true);
    expect(jwtVerify).toHaveBeenCalledWith('student-token', expect.any(Function), {
      issuer: settings.AUTH_ISSUER, audience: settings.AUTH_AUDIENCE, requiredClaims: ['exp'],
    });
    expect(request.user).toEqual({ id: 'student-id', role: 'STUDENT' });
  });

  it('rejects requests without a bearer token before verification', async () => {
    await expect(new JwtAuthGuard(config).canActivate(http().context)).rejects.toThrow('Bearer token is required');
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('rejects incomplete claims and invalid tokens', async () => {
    const { context, request } = http('Bearer example-token');
    const guard = new JwtAuthGuard(config);
    jwtVerify.mockResolvedValueOnce({ payload: { sub: 'student-id' } });
    jwtVerify.mockRejectedValueOnce(new Error('expired'));

    await expect(guard.canActivate(context)).rejects.toThrow('Token payload is incomplete');
    await expect(guard.canActivate(context)).rejects.toThrow('Invalid or expired access token');
    expect(request.user).toBeUndefined();
  });
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows routes with no role metadata', () => {
    expect(guard.canActivate(http().context)).toBe(true);
  });

  it('only allows the declared role', () => {
    const staff = http(undefined, { id: 'operator', role: 'STAFF' });
    const student = http(undefined, { id: 'student', role: 'STUDENT' });
    Reflect.defineMetadata(ROLES_KEY, ['STAFF'], staff.handler);
    Reflect.defineMetadata(ROLES_KEY, ['STAFF'], student.handler);

    expect(guard.canActivate(staff.context)).toBe(true);
    expect(() => guard.canActivate(student.context)).toThrow('Your role cannot perform this action');
  });
});
