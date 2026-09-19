import { Module } from '@nestjs/common';

import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

@Module({ providers: [JwtAuthGuard, RolesGuard], exports: [JwtAuthGuard, RolesGuard] })
export class AuthModule {}
