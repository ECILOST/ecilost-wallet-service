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
