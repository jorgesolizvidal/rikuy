# ADR-019 — Jobs durables del piloto en Vercel, con ledger en PostgreSQL

- **Estado:** Aceptada — 2026-10-17
- **Modifica:** ADR-014 (Trigger.dev como runtime único de jobs) para las fases P2–P6
- **Evidencia:** benchmarks P0 (septiembre de 2026)

## Contexto

ADR-014 eligió Trigger.dev porque el procesamiento nativo de panoramas podría exceder los límites de las funciones web. Los benchmarks P0 midieron el pipeline real con las panorámicas disponibles (2048–2880 px): generar **las cinco variantes** de una escena tomó **9–10,5 s** con un pico de memoria **< 200 MiB**. Eso cabe con amplio margen en una función de Vercel (sharp/libvips soportado, hasta minutos de ejecución y GB de memoria según plan).

Agregar un tercer proveedor (cuenta, control plane, despliegue y costos aparte) en el piloto no tiene una necesidad medida y aumenta la superficie operativa para un equipo pequeño.

## Decisión

1. Se conserva íntegro el **contrato de ADR-014**: tabla `background_jobs` como outbox + ledger, claves lógicas idempotentes, leases con fencing token, checkpoints, dead-letter y replay auditado. La base de datos es la fuente de verdad del trabajo, no el runtime.
2. El **runtime del piloto se ejecuta en Vercel** (Vercel Workflow o Functions + cron de drenaje, según límites vigentes verificados al iniciar P2), detrás de un puerto `JobRunner`.
3. Los procesadores (`apps/worker`) son funciones puras sobre los casos de uso de `@rikuy/core`; no conocen el runtime.

## Condiciones para reabrir (migrar a Trigger.dev u otro runtime)

- Fuentes ≥ 8K/16K cuyo procesamiento supere el 50 % del tiempo o memoria máximos de la función.
- Backlog sostenido > 5 min o necesidad de concurrencia por tenant que la plataforma no ofrezca.
- Requisitos de región, aislamiento o costo medido que no se cumplan.

Como el ledger y los procesadores son independientes del runtime, el cambio es un adaptador nuevo, no una reescritura.

## Consecuencias

- (+) Un proveedor menos en el piloto; despliegue y observabilidad en un solo lugar.
- (+) Se mantiene la portabilidad prevista por ADR-014.
- (−) Los límites de duración/memoria de Vercel pasan a ser restricción de admisión de medios (validados en P2 con el corpus real).
- (−) El plan Hobby no admite uso comercial: el primer cliente de pago implica Vercel Pro.
