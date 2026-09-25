import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class RechargeWalletDto {
  // ECICoin vale lo mismo que el peso colombiano: las recargas son enteras, sin centavos.
  @Type(() => Number)
  @IsInt({ message: 'amount must be an integer number of ECICoin' })
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;
}
