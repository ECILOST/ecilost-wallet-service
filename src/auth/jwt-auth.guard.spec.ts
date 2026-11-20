import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from './authenticated-user.interface';
import { JwtAuthGuard } from './jwt-auth.guard';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'ecilost-test';
const { createRemoteJWKSet } = vi.hoisted(() => ({ createRemoteJWKSet: vi.fn() }));

vi.mock('jose', async (importOriginal) => ({
  ...await importOriginal<typeof import('jose')>(),
  createRemoteJWKSet,
}));

function requestContext(token: string) {
  const request: { headers: { authorization: string }; user?: AuthenticatedUser } = {
    headers: { authorization: `Bearer ${token}` },
  };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let guard: JwtAuthGuard;

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
  });

  beforeEach(async () => {
    const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'RS256', kid: 'test' };
    createRemoteJWKSet.mockReturnValue(createLocalJWKSet({ keys: [jwk] }));
    guard = new JwtAuthGuard(new ConfigService({
      AUTH_JWKS_URL: `${ISSUER}/.well-known/jwks.json`,
      AUTH_ISSUER: ISSUER,
      AUTH_AUDIENCE: AUDIENCE,
    }));
  });

  function token(expiresIn?: string) {
    const jwt = new SignJWT({ role: 'STUDENT' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('student-fixture');
    if (expiresIn) jwt.setExpirationTime(expiresIn);
    return jwt.sign(keys.privateKey);
  }

  it('acepta un JWT vigente y asigna el usuario', async () => {
    const { context, request } = requestContext(await token('1m'));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'student-fixture', role: 'STUDENT' });
  });

  it.each([
    { status: 'sin vencimiento', expiresIn: undefined },
    { status: 'vencido', expiresIn: '-1m' },
  ])('responde 401 con un JWT $status', async ({ expiresIn }) => {
    const { context, request } = requestContext(await token(expiresIn));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });
});
