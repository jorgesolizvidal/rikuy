# ADR-025 — La base de datos despierta al ejecutor de trabajos

- **Estado:** Aceptada — 2026-10-24 (decisión del usuario)
- **Concreta:** ADR-019 («Vercel Workflow o Functions + cron de drenaje, según límites vigentes verificados al iniciar P2»)

## Contexto

El ejecutor de trabajos corre como una función de Vercel (ADR-019). Alguien tiene que llamarla cuando hay trabajo. En el plan Hobby, el cron de Vercel corre **como mucho una vez al día** y con ±59 min de precisión ([documentación de Vercel](https://vercel.com/docs/cron-jobs/usage-and-pricing)): no sirve para una cola. Las opciones evaluadas fueron:

| Opción                                                             | Costo   | Latencia                   | Observaciones                                                   |
| ------------------------------------------------------------------ | ------- | -------------------------- | --------------------------------------------------------------- |
| Base de datos: aviso al encolar + `pg_cron` cada minuto (`pg_net`) | Gratis  | Segundos; respaldo ≤ 1 min | La base ya es la fuente de verdad y el reloj del ledger         |
| GitHub Actions programado                                          | Gratis  | Hasta ~5 min, sin garantía | Depende de otro proveedor para algo de producción               |
| Vercel Pro (cron cada minuto)                                      | De pago | ≤ 1 min                    | Necesario igualmente antes de un municipio real (uso comercial) |

## Decisión

1. **Aviso inmediato:** un trigger en `background_jobs` llama al endpoint del ejecutor (`POST /api/jobs/drain` del host de la plataforma) con `pg_net` cuando un trabajo queda listo al escribirse (encolado o reintento a mano). `pg_net` envía la petición solo después del `COMMIT`: un encolado revertido no despierta a nadie.
2. **Respaldo:** `pg_cron` llama a la misma función cada minuto, solo si hay trabajo listo o un arrendamiento vencido: así se toman los reintentos cuya espera venció y los trabajos de un ejecutor que se cayó.
3. **A lo sumo un aviso cada 10 s**, para que una ráfaga de trabajos despierte al ejecutor una vez.
4. **Configuración en Supabase Vault** (`rikuy_job_runner_url`, `rikuy_job_runner_secret`), cargada por un operador. Sin ella no se llama a nadie (desarrollo local, CI).
5. El secreto es **propio del ejecutor**: solo sirve para pedir que se drene la cola. No es la clave secreta de Supabase, porque `pg_net` deja las peticiones en cola legibles para los roles con acceso a su esquema hasta que se envían.
6. El endpoint responde 202 enseguida y drena después de responder (`after()`), dentro del límite de 5 min de la función. Un operador también puede drenar desde el panel («Procesar la cola ahora»).

## Consecuencias

- (+) Gratis en el plan actual y con una latencia de segundos.
- (+) Toda la programación vive en la base (migración versionada); cambiar de ejecutor es cambiar una URL en Vault.
- (−) Depende de `pg_net` y `pg_cron` de Supabase; si se migra de proveedor de base, hay que reemplazar los avisos.
- (−) Un reintento con espera corta se toma en la siguiente pasada del respaldo (hasta 1 min), no en el segundo exacto en que vence.
- Si el plan pasa a Vercel Pro, se puede sumar un cron de Vercel como tercera vía sin cambiar nada de esto.
