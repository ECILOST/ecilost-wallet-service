/**
 * Mismo Postgres que el desarrollo local, otra base: las migraciones de wallet escriben el
 * esquema "wallet" a mano, asi que no se pueden aislar con `?schema=`. Las pruebas vacian
 * esta base a voluntad.
 */
export const integrationDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://wallet:wallet@localhost:5435/ecilost_wallet_it?schema=wallet';
