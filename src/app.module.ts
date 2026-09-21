import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AuthModule } from "./auth/auth.module";
import { HealthModule } from "./health/health.module";
import { WalletModule } from "./wallet/wallet.module";
import { EventsModule } from "./events/events.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    HealthModule,
    WalletModule,
    EventsModule,
  ],
})
export class AppModule {}
