import { Module } from "@nestjs/common";
import { WalletModule } from "../wallet/wallet.module";
import { UserCreatedConsumer } from "./user-created.consumer";
import { BidHoldConsumer } from './bid-hold.consumer';

@Module({ imports: [WalletModule], providers: [UserCreatedConsumer, BidHoldConsumer] })
export class EventsModule {}
