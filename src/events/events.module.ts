import { Module } from "@nestjs/common";
import { WalletModule } from "../wallet/wallet.module";
import { UserCreatedConsumer } from "./user-created.consumer";

@Module({ imports: [WalletModule], providers: [UserCreatedConsumer] })
export class EventsModule {}
