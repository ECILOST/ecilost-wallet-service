import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class RechargeWalletDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;
}
