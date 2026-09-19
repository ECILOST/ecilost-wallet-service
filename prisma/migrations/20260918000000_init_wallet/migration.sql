CREATE SCHEMA IF NOT EXISTS "wallet";

CREATE TYPE "wallet"."WalletTransactionType" AS ENUM (
  'INITIAL_ISSUANCE',
  'ADMIN_RECHARGE',
  'HOLD',
  'RELEASE',
  'DEBIT'
);

CREATE TABLE "wallet"."wallets" (
  "id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "available_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "held_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallets_available_balance_nonnegative" CHECK ("available_balance" >= 0),
  CONSTRAINT "wallets_held_balance_nonnegative" CHECK ("held_balance" >= 0)
);

CREATE TABLE "wallet"."wallet_transactions" (
  "id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "type" "wallet"."WalletTransactionType" NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "available_delta" DECIMAL(18,2) NOT NULL,
  "held_delta" DECIMAL(18,2) NOT NULL,
  "reference" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallets_user_id_key" ON "wallet"."wallets"("user_id");
CREATE UNIQUE INDEX "wallet_transactions_reference_key" ON "wallet"."wallet_transactions"("reference");
CREATE INDEX "wallet_transactions_wallet_id_created_at_idx"
  ON "wallet"."wallet_transactions"("wallet_id", "created_at" DESC);

ALTER TABLE "wallet"."wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_wallet_id_fkey"
  FOREIGN KEY ("wallet_id") REFERENCES "wallet"."wallets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
