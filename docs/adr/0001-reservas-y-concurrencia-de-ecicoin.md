# ADR-0001: Reservas de ECICoin en Wallet y concurrencia sin SERIALIZABLE

## Estado

Accepted para HU-14, HU-20, HU-24 y HU-29. Revisado el 2026-10-17 tras las pruebas de carga.

## Contexto

Cada puja compromete ECICoin antes de entrar, y quien es superado debe recuperarlos al instante
para pujar en otra sala. Auction decide el orden de las pujas, pero no es dueño del dinero: el
saldo vive en Wallet, con su propia base. Las garantías que no se pueden romper son tres: ningún
saldo negativo, nunca el mismo dinero comprometido dos veces y un solo cobro por ronda.

La primera versión corría cada operación en una transacción `SERIALIZABLE` con 3 reintentos. Con
25 a 100 estudiantes pujando, operaciones sobre billeteras **distintas** chocaban por los bloqueos
de predicado: el 16 % al 26 % de las pujas se rechazaban como "saldo insuficiente" con saldo de
sobra, y una liquidación que chocaba se descartaba y dejaba al ganador sin cobrar
(`ecilost-load-tests/docs/RESULTADOS.md`, H2 a H4).

## Decisiones

1. **La reserva vive en Wallet.** Una fila de `wallet_holds` por estudiante y ronda
   (`bid:{roundId}:{userId}`). Cada puja fija el monto de su reserva: Wallet mueve solo la
   diferencia entre `available` y `held`, así que mejorar la propia puja no acumula reservas.
   Liberar va versionado por monto: un aviso tardío de una puja anterior no libera la vigente.
2. **READ COMMITTED con bloqueo corto de la fila de la billetera.** Toda operación bloquea primero
   la fila de su billetera y recién después lee la reserva. Dos operaciones sobre la misma
   billetera se turnan; las de billeteras distintas no se tocan. Es un candado de una fila, no
   una transacción larga: el proyecto prioriza el tiempo real.
3. **El dinero lo cuida la base, no el aislamiento.** Hay `CHECK (available_balance >= 0)` y
   `CHECK (held_balance >= 0)`, los updates son condicionales (`... WHERE available >= delta`) y
   `settle:{roundId}` es única entre los movimientos, así que una ronda no se cobra dos veces.
4. **La liquidación ordena sus bloqueos.** Al cerrar una ronda, Wallet bloquea las billeteras en
   orden de `walletId` y relee cada reserva: dos liquidaciones simultáneas no se esperan en cruz,
   y si otra se adelantó, la reserva ya no está y se salta.
5. **Una liquidación nunca se descarta.** Si falla, el mensaje pasa a
   `ecilost.wallet.round-settlements.retry` y vuelve en 1 s. Los errores de carga se reintentan sin
   límite; un mensaje ilegible o un error que se repite 5 veces va a `.dead` para revisarlo.
6. **Las respuestas dicen por qué.** Una reserva rechazada responde `reason`:
   `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `RETRY` o `ERROR`. Auction solo muestra "saldo
   insuficiente" cuando de verdad falta saldo; si Wallet estaba ocupada, responde 503.

## Alternativas descartadas

- **Mantener `SERIALIZABLE` con más reintentos:** reduce los choques, pero no los elimina, y
  alarga la respuesta de cada puja.
- **Reservar en Auction:** dos dueños del mismo saldo, o un join entre bases de datos.

## Consecuencias

- Con 100 estudiantes pujando mientras cierra otra sala: 0 rechazos falsos (antes 599), p95 de una
  puja de 4,5 s a 2,1 s, y la ronda que cerró en medio de la carga quedó liquidada al primer intento.
- La garantía ya no depende de que nadie olvide `SERIALIZABLE`: cualquier código nuevo que cambie
  saldos o reservas tiene que bloquear primero la billetera (`lockWallet`).
- Riesgo residual: una reserva que llegue después de liquidar su ronda queda retenida. Auction lo
  evita haciendo que sus solicitudes venzan a los 5 s.

## Evidencia

- `src/wallet/application/wallet.service.ts`: `hold`, `release`, `settleRound`, `lockWallet`.
- `src/events/round-settlement.consumer.ts`: cola de reintento y cola `.dead`.
- `test/wallet-concurrency.int-spec.ts`: 7 pruebas de concurrencia contra PostgreSQL real
  (`npm run test:integration`). Con la versión `SERIALIZABLE` fallan 5.
- `ecilost-load-tests/docs/RESULTADOS.md`, sección "Despues de la correccion".
