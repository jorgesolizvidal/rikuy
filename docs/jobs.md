# Trabajos en segundo plano — runbook

Cómo funcionan los trabajos durables de Rikuy y qué hacer cuando algo falla. Decisiones: [ADR-019](adr/ADR-019-pilot-jobs-on-vercel.md) (que ajusta el contrato de ADR-014, resumido en el [índice de ADRs](adr/README.md)). Migración: `supabase/migrations/20261020000000_p2_job_ledger.sql`.

## Qué es

Un **trabajo** es algo que la plataforma hace fuera de una página: procesar un panorama, optimizar un modelo 3D, limpiar subidas abandonadas. La base de datos es la **fuente de verdad**:

- `background_jobs` es a la vez la bandeja de salida (_outbox_) y el registro (_ledger_). La operación que pide el trabajo lo inserta **en la misma transacción**; si la operación se confirma, el trabajo existe. Pedir dos veces lo mismo (mismo municipio, tipo y clave lógica) no crea un segundo trabajo.
- `job_attempts` guarda cada intento, sin borrar ni modificar los cerrados.
- `job_kinds` y `job_queues` son la configuración: intentos máximos, arrendamiento, presupuesto de tiempo por intento y concurrencia (global por cola y por municipio).

Un **ejecutor** (desde P2 · Paso 2, una función de Vercel) reclama trabajos, los ejecuta y avisa el resultado. Si el ejecutor cambia (otro proveedor, un CLI), el registro y los procesadores no cambian.

## Estados

| Estado      | En el panel | Qué significa                                                                            |
| ----------- | ----------- | ---------------------------------------------------------------------------------------- |
| pending     | En espera   | Listo para correr, o esperando su próximo reintento (se muestra la hora)                 |
| running     | En curso    | Un ejecutor lo tiene, con un arrendamiento vigente                                       |
| succeeded   | Terminado   | Terminó bien; su resultado quedó registrado una sola vez                                 |
| dead_letter | Fallido     | Falló sin arreglo automático: se acabaron los intentos o el error no se puede reintentar |

## Garantías

- **Arrendamiento y _fencing_.** Al reclamar, el ejecutor recibe un arrendamiento (`lease_until`) y un número de _fencing_ que siempre crece. Mientras trabaja lo renueva (latido). Cualquier escritura (latido, punto de control, resultado) lleva ese número; si el arrendamiento venció y otro ejecutor tomó el trabajo, la base rechaza al anterior aunque siga vivo.
- **Puntos de control.** Un procesador puede guardar su avance; el intento siguiente empieza desde ahí.
- **Reintentos.** Los fallos transitorios (un servicio que no responde) se reintentan con espera exponencial: 5 s, 10 s, 20 s… hasta 5 min, con variación aleatoria, respetando el `Retry-After` del servicio (hasta 1 h). Los permanentes (archivo inválido, permiso revocado, cuota agotada) van directo a «Fallidos».
- **Presupuesto de tiempo.** Un intento que supera el máximo de su tipo ya no puede renovar el arrendamiento: se registra como fallo transitorio.
- **Equidad.** La base limita la concurrencia por cola y por municipio al reclamar, y atiende primero a los municipios con menos trabajos en curso: un municipio con mucho trabajo no frena a los demás.
- **Al menos una vez.** Si un ejecutor muere después de hacer el trabajo y antes de avisar, el trabajo se repite. Por eso todo procesador es **idempotente**: hacerlo dos veces deja lo mismo que hacerlo una (ADR-009).
- **Sin secretos.** El registro no guarda URLs firmadas: los mensajes de error se recortan en el `?`. El panel nunca muestra el contenido (_payload_), el punto de control ni el resultado de un trabajo.

## El rol del ejecutor

El ejecutor se conecta a PostgreSQL como `rikuy_worker`:

- sin permisos sobre ninguna tabla; solo puede ejecutar las funciones del esquema `worker_api` (`claim_jobs`, `heartbeat`, `complete_job`, `fail_job`, `reap_expired_jobs`);
- no es `service_role` ni la sesión de una persona, y ninguna clave de la API puede convertirse en él;
- la migración lo crea **sin permiso de iniciar sesión**. Se habilita una sola vez, fuera del repositorio, cuando exista el ejecutor (P2 · Paso 2):

  ```sql
  -- Supabase → SQL Editor. La contraseña la generas tú; nunca va al repositorio.
  alter role rikuy_worker with login password '<contraseña larga y aleatoria>';
  ```

  La cadena de conexión va en Vercel como variable sensible (`WORKER_DATABASE_URL`), por el _pooler_ en modo transacción: `postgres://rikuy_worker.<ref>:<contraseña>@<host-del-pooler>:6543/postgres`.

## El panel: `/plataforma/trabajos`

Solo para operadores con el segundo factor verificado (para cualquier otra persona la página no existe).

- **Resumen:** en espera (y cuántos están listos), en curso, fallidos y terminados en las últimas 24 h.
- **Alarma:** si hay trabajos listos esperando más de 5 minutos, aparece un aviso: ningún ejecutor los está tomando.
- **Lista** filtrable por estado, con intentos, último error y «Ver intentos» (el historial completo).
- **Reintentar** (solo fallidos, con confirmación): crea una **ronda nueva** con los intentos en cero; las rondas anteriores quedan en el historial. Queda auditado (`job.replayed`).
- **Probar el ejecutor:** pone en la cola una prueba que no cambia ningún dato (`system.probe`) para un municipio. Tres modos: normal, «falla el primer intento» (ensayo de reintento) y «falla siempre» (ensayo de la cola de fallidos). Queda auditado (`job.probe_requested`).

## Qué hacer si…

**Aparece la alarma de trabajos esperando.** El ejecutor no está corriendo o no llega a la base. Revisa en Vercel los registros de la función del ejecutor y su programación. Mientras tanto no se pierde nada: los trabajos esperan en la base y salen cuando el ejecutor vuelve.

**Hay trabajos fallidos.** Abre «Ver intentos» y lee el código de error:

- `lease_expired`: el ejecutor dejó de responder a mitad (caída, despliegue, tiempo de la función agotado). Si se repite en el mismo trabajo, puede que no quepa en el tiempo de la función.
- `time_budget_exceeded`: el intento superó su presupuesto de tiempo.
- `no_processor` / `unsupported_schema_version`: el ejecutor desplegado no sabe hacer ese tipo o esa versión (un despliegue a medias). Reintenta tras desplegar.
- `unexpected_error`: un error sin clasificar del procesador; el mensaje dice cuál.
- Errores del propio procesador (`invalid_source`, `probe_failure`…): según su significado.

Corrige la causa y luego «Reintentar». Reintentar sin corregir solo vuelve a fallar.

**Un trabajo quedó «En curso» mucho tiempo.** No hace falta tocarlo: cuando vence su arrendamiento, la próxima pasada del ejecutor (o del reconciliador) lo devuelve a la cola o, sin intentos, lo manda a fallidos.

**Quiero comprobar que todo funciona.** «Probar el ejecutor» en modo normal: debe pasar a «Terminado» en la próxima pasada. Para ensayar fallas, «falla el primer intento» (termina en el segundo) y «falla siempre» (termina en «Fallidos» tras 3 intentos; desde ahí se puede ensayar «Reintentar»).

## Lo que no se hace

- Editar `background_jobs` o `job_attempts` a mano en producción: todo cambio pasa por las funciones (que validan el _fencing_) o por «Reintentar».
- Dar al ejecutor la clave secreta (`service_role`) o la sesión de una persona.
- Escribir URLs firmadas, tokens o contenido de archivos en mensajes de error o en registros.

## Pruebas

- `supabase/tests/database/013_job_ledger.test.sql` (pgTAP, 71 aserciones): permisos, idempotencia, reclamo con equidad y concurrencia, _fencing_, latido, puntos de control, reintentos, fallidos, presupuesto de tiempo, reintento a mano y auditoría.
- `packages/db/src/job-ledger.int.test.ts` — **D-01** contra PostgreSQL real, con varios ejecutores a la vez: un ejecutor que muere sin avisar, retomar desde el punto de control con el ejecutor viejo bloqueado, encolar duplicados al mismo tiempo, fallidos y reintento a mano, un municipio que satura la cola sin frenar a otro, y los límites del rol del ejecutor.
- `packages/core/src/application/jobs/jobs.test.ts` y `apps/worker/src/processors/probe.test.ts`: el ejecutor de un trabajo (latido, pérdida del arrendamiento, presupuesto, errores) y el drenaje.
