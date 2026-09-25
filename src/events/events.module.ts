import { Module } from "@nestjs/common";
import { WalletModule } from "../wallet/wallet.module";
import { UserCreatedConsumer } from "./user-created.consumer";
import { BidHoldConsumer } from './bid-hold.consumer';
import { BidReleaseConsumer } from './bid-release.consumer';
import { RoundSettlementConsumer } from './round-settlement.consumer';

@Module({ imports: [WalletModule], providers: [UserCreatedConsumer, BidHoldConsumer, BidReleaseConsumer, RoundSettlementConsumer] })
export class EventsModule {}
