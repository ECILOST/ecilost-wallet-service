CREATE TABLE "wallet"."wallet_holds" (
  "id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "wallet_holds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_holds_amount_nonnegative" CHECK ("amount" >= 0),
  CONSTRAINT "wallet_holds_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"."wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "wallet_holds_reference_key" ON "wallet"."wallet_holds"("reference");
CREATE INDEX "wallet_holds_wallet_id_idx" ON "wallet"."wallet_holds"("wallet_id");
