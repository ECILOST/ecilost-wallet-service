import { execFileSync } from 'node:child_process';
import { integrationDatabaseUrl } from './database';

/**
 * Deja la base de pruebas (`ecilost_wallet_it`, aparte de la de desarrollo) al dia antes de
 * la primera prueba; Prisma la crea si no existe. Requiere el Postgres de wallet arriba:
 * `docker compose up -d`.
 */
export default function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: integrationDatabaseUrl },
  });
}
