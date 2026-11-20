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
test/                   # Integracion contra PostgreSQL (npm run test:integration)
docs/                   # Contratos y decisiones
```

## Inicio local

```bash
cp .env.example .env
npm install
docker compose up -d
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

Completa `DATABASE_URL`, `RABBITMQ_URL` y los valores de Auth en `.env`. Wallet verifica JWT mediante `AUTH_JWKS_URL`, `AUTH_ISSUER` y `AUTH_AUDIENCE`. Levanta Auth y RabbitMQ para probar la integración con Auction.

El endpoint público de salud es [GET /wallet/health](http://localhost:3002/wallet/health). Importa el [contrato OpenAPI](docs/openapi.json) en Swagger Editor para consultar rutas y esquemas.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" http://localhost:3002/wallet/me
```

## HU-09: emisión y recargas

Las rutas de saldo, historial y recargas requieren `Authorization: Bearer <access-token>` emitido por Auth. Un JWT ausente, vencido o sin `exp` produce `401`.

- `POST /wallet/me/bootstrap`: crea la billetera del usuario autenticado y registra una
  única emisión inicial. Es idempotente: llamadas posteriores no acreditan de
  nuevo el saldo inicial.
- `POST /wallet/:userId/recharges`: acredita una recarga administrada. Solo el
  rol `STAFF` puede usarla. El cuerpo es `{ "amount": 50000, "reference":
  "opcional-idempotente" }`; los montos deben ser enteros positivos: un ECICoin
  vale lo mismo que un peso colombiano, sin centavos.

Cada recarga actualiza el saldo disponible y crea el movimiento contable en la
misma transacción de PostgreSQL. Si se repite una `reference`, se devuelve el
resultado original sin duplicar el crédito.

## HU-10: consulta de saldo e histórico

- `GET /wallet/me`: devuelve la billetera con `availableBalance` y `heldBalance` como cadenas decimales. Responde `404` si falta la billetera. El cliente puede aprovisionarla mediante `POST /wallet/me/bootstrap`.
- `GET /wallet/me/transactions?page=1&pageSize=20`: lista movimientos del
  usuario autenticado, del más reciente al más antiguo. Cada elemento incluye
  tipo, monto y fecha.

El historial devuelve `items: []` y `total: 0` cuando aún falta la billetera. `pageSize` admite entre 1 y 100 resultados.

## Pruebas

```bash
npm test
npm run typecheck
npm run test:integration
```

La suite de integración usa PostgreSQL de prueba. Consulta `vitest.config.integration.ts` y `test/` para la configuración de su base.
