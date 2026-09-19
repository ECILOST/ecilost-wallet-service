# ECILOST Wallet Service

Microservicio de billetera ECICoin. Valida JWT RS256 publicados por
`auth-service` y conserva sus propios datos en PostgreSQL.

## Estructura

```text
src/wallet/
  domain/               # Entidades e invariantes
  application/          # Casos de uso
  infrastructure/       # Persistencia e integraciones
  presentation/http/    # Controllers y DTOs
prisma/                 # Esquema y migraciones
test/                   # Unitarias y e2e
docs/                   # Contratos y decisiones
```

## Inicio local

```bash
cp .env.example .env
npm install
docker compose up -d
npx prisma generate
npm run start:dev
```

El endpoint de salud es `GET /wallet/health` en el puerto `3002`.

## HU-09: emisión y recargas

Todas las rutas requieren `Authorization: Bearer <access-token>` emitido por
`auth-service`.

- `POST /wallet/me/bootstrap`: crea la billetera del estudiante y registra una
  única emisión inicial. Es idempotente: llamadas posteriores no acreditan de
  nuevo el saldo inicial.
- `POST /wallet/:userId/recharges`: acredita una recarga administrada. Solo el
  rol `STAFF` puede usarla. El cuerpo es `{ "amount": 25, "reference":
  "opcional-idempotente" }`; los montos deben ser positivos y tener hasta dos
  decimales.

Cada recarga actualiza el saldo disponible y crea el movimiento contable en la
misma transacción de PostgreSQL. Si se repite una `reference`, se devuelve el
resultado original sin duplicar el crédito.
