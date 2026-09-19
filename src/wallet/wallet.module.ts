import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { WalletController } from './presentation/http/wallet.controller';
import { WalletService } from './application/wallet.service';

@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [PrismaService, WalletService],
})
export class WalletModule {}
