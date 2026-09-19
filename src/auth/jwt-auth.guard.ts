import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';

import { AuthenticatedUser } from './authenticated-user.interface';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwks: JWTVerifyGetKey;

  constructor(config: ConfigService) {
    this.issuer = config.getOrThrow<string>('AUTH_ISSUER');
    this.audience = config.getOrThrow<string>('AUTH_AUDIENCE');
    this.jwks = createRemoteJWKSet(new URL(config.getOrThrow<string>('AUTH_JWKS_URL')));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: AuthenticatedUser;
    }>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token is required');
    }

    try {
      const { payload } = await jwtVerify(authorization.slice(7).trim(), this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
        throw new UnauthorizedException('Token payload is incomplete');
      }
      request.user = { id: payload.sub, role: payload.role };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
