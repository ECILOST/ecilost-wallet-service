import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AuthenticatedUser } from '../../../auth/authenticated-user.interface';
import { CurrentUser } from '../../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import { Roles } from '../../../auth/roles.decorator';
import { RolesGuard } from '../../../auth/roles.guard';
import { WalletService } from '../../application/wallet.service';
import { RechargeWalletDto } from './dto/recharge-wallet.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post('me/bootstrap')
  bootstrap(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.bootstrap(user.id);
  }

  @Get('me')
  getBalance(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.getBalance(user.id);
  }

  @Get('me/transactions')
  listTransactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTransactionsQueryDto,
  ) {
    return this.walletService.listTransactions(user.id, query.page, query.pageSize);
  }

  @Post(':userId/recharges')
  @Roles('STAFF')
  @UseGuards(RolesGuard)
  recharge(
    @Param('userId') userId: string,
    @Body() dto: RechargeWalletDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.walletService.recharge(userId, dto.amount, user.id, dto.reference);
  }
}
