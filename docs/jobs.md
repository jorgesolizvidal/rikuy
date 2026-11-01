# Trabajos en segundo plano — runbook

Cómo funcionan los trabajos durables de Rikuy y qué hacer cuando algo falla. Decisiones: [ADR-019](adr/ADR-019-pilot-jobs-on-vercel.md) (que ajusta el contrato de ADR-014, resumido en el [índice de ADRs](adr/README.md)). Migración: `supabase/migrations/20261020000000_p2_job_ledger.sql`.

## Qué es

Un **trabajo** es algo que la plataforma hace fuera de una página: procesar un panorama, optimizar un modelo 3D, limpiar subidas abandonadas. La base de datos es la **fuente de verdad**:

- `background_jobs` es a la vez la bandeja de salida (_outbox_) y el registro (_ledger_). La operación que pide el trabajo lo inserta **en la misma transacción**; si la operación se confirma, el trabajo existe. Pedir dos veces lo mismo (mismo municipio, tipo y clave lógica) no crea un segundo trabajo.
- `job_attempts` guarda cada intento, sin borrar ni modificar los cerrados.
- `job_kinds` y `job_queues` son la configuración: intentos máximos, arrendamiento, presupuesto de tiempo por intento y concurrencia (global por cola y por municipio).

Un **ejecutor** (una función de Vercel, `apps/web/src/server/job-runner.ts`) reclama trabajos, los ejecuta y avisa el resultado. Si el ejecutor cambia (otro proveedor, un CLI), el registro y los procesadores no cambian.

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

- sin permisos sobre ninguna tabla; solo puede ejecutar las funciones del esquema `worker_api` (`claim_jobs`, `heartbeat`, `complete_job`, `fail_job`, `reap_expired_jobs` y las de cada tipo de trabajo, como `abandoned_upload` y `mark_upload_abandoned`);
- no es `service_role` ni la sesión de una persona, y ninguna clave de la API puede convertirse en él;
- la migración lo crea **sin permiso de iniciar sesión**; un operador lo habilita una vez (ver «Activar el ejecutor»);
- la conexión va cifrada (TLS) a cualquier base que no sea local, por el _pooler_ en modo transacción.

## Cómo se despierta ([ADR-025](adr/ADR-025-job-runner-wake-up.md))

- **Al encolar:** cuando un trabajo queda listo al escribirse (nuevo o reintento a mano), la base llama a `POST https://<host de la plataforma>/api/jobs/drain` con `pg_net`, después del `COMMIT`.
- **Cada minuto, de respaldo** (`pg_cron`, tarea `rikuy-job-runner`): solo si hay trabajo listo o un arrendamiento vencido (reintentos cuya espera venció, trabajos de un ejecutor caído).
- **A lo sumo un aviso cada 10 s.** El endpoint responde 202 y drena después de responder: toma trabajos durante los primeros ~40 s y guarda 4 min para el más largo (un panorama puede tardar hasta 240 s), dentro de los 5 min de la función. Lo que llegue después lo toma el siguiente aviso (a lo sumo un minuto). Varias llamadas a la vez no se pisan: la base reparte los trabajos.
- **A mano:** «Procesar la cola ahora» en el panel (unos 20 s). No toma panoramas ni modelos 3D: no caben en ese tiempo; los procesa el aviso de la base.
- Sin la configuración en Vault (desarrollo local, CI) la base no llama a nadie.

## Tipos de trabajo

| Tipo                                                                | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Cuándo se encola                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `system.probe` — Prueba del ejecutor                                | No cambia ningún dato; ensaya el camino completo                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | «Probar el ejecutor» en el panel                                                                                                 |
| `media.expire_abandoned_upload` — Limpieza de una subida abandonada | Borra el original de una imagen que quedó «subiendo» más de 24 h (si llegó a escribirse) y la marca rechazada, con auditoría (`media.upload_abandoned`)                                                                                                                                                                                                                                                                                                                                                                      | Cada día a las 07:17 UTC (03:17 en Bolivia), tarea `rikuy-expire-abandoned-uploads`                                              |
| `media.process_panorama` — Procesamiento de un panorama 360°        | Revisa los bytes reales (tipo, peso, tamaño, proporción 2:1), genera la vista previa (≤ 40 KB), la imagen única (≤ 4096 px, WebP) y, si la fuente supera 4096 px, teselas de 512 px por niveles, en `{municipio}/{recurso}/{versión}/panorama/` del bucket privado. El original no cambia. Guarda el manifiesto y audita `media.panorama_ready` o `media.panorama_rejected`                                                                                                                                                  | Al terminar la subida en «Panoramas 360°» (`submit_panorama`, auditado `media.panorama_submitted`)                               |
| `media.process_model` — Optimización de un modelo 3D (GLB)          | Valida el GLB (JSON, validador de Khronos, archivos externos, extensiones, complejidad) y codifica cada textura en KTX2 según su uso. Verifica cada textura decodificándola (ETC1S → UASTC → la original). Comprime la geometría con Meshopt y comprueba que materiales y colores por vértice no cambien. Escribe `{municipio}/{recurso}/{versión}/model/model.glb` (privado; las texturas intermedias esperan en `model/work/` entre intentos) y audita `media.model_ready` o `media.model_rejected`. El original no cambia | Al terminar la subida en «Modelos 3D» (`submit_model`, auditado `media.model_submitted`)                                         |
| `media.remove_unused` — Limpieza de una imagen sin uso              | Si la foto o el logo sigue sin usarse (ninguna revisión de contenido, punto de tour ni versión de la marca), la rechaza primero, audita `media.unused_removed` con los bytes liberados y después borra los archivos de su carpeta en los dos buckets ([ADR-035](adr/ADR-035-free-plan-operations.md)). Panoramas y modelos nunca. Una versión que volvió a usarse queda igual (`in_use`)                                                                                                                                     | Cada día a las 07:37 UTC (03:37 en Bolivia), tarea `rikuy-remove-unused-media`, para lo que lleva más de 7 días listo y sin uso  |
| `mail.membership_invitation` — Correo de invitación                 | Lee bajo su arrendamiento la dirección, el municipio y el rol de una invitación pendiente y envía un correo por SMTP; registra `memberships.invitation_mailed_at` y audita `membership.invitation_mailed` ([ADR-034](adr/ADR-034-commercial-demos-and-mail.md)). Sin SMTP configurado termina sin enviar (`mail_not_configured`); una invitación aceptada, revocada o reemplazada no se envía; un servidor que rechaza la dirección (5xx) va a «Fallidos»                                                                    | Al invitar a alguien (`add_tenant_member`) y al dar de alta un municipio (propietario invitado), con un trigger en `memberships` |
| `media.extract_document` — Lectura de un documento de conocimiento  | Revisa los bytes reales (PDF con texto o texto UTF-8/Windows-1252), extrae el texto por página con pdf.js y lo guarda junto al original (`…/document/text.json`) con su manifiesto ([ADR-037](adr/ADR-037-assistant-knowledge.md)). Un PDF escaneado, protegido o dañado, o algo que no es un documento, se rechaza con su motivo y se borra el original                                                                                                                                                                     | Al subir un documento en «Conocimiento del asistente» (`submit_document`)                                                        |
| `knowledge.index` — Indexación del conocimiento del asistente       | Corta la revisión sellada de un destino, evento, conocimiento (con su documento) o tour en fragmentos para la búsqueda del asistente y los guarda todos de una vez. Determinista: indexar dos veces da lo mismo                                                                                                                                                                                                                                                                                                              | Al cambiar el puntero publicado de un contenido o un tour (publicar, volver a una versión)                                       |

## Informe diario

Cada día a las 11:07 UTC (07:07 en Bolivia) la tarea `rikuy-daily-report` despierta al ejecutor con la razón `daily` ([ADR-035](adr/ADR-035-free-plan-operations.md)), con la misma dirección y el mismo secreto de Vault que el aviso de la cola. El ejecutor lee `worker_api.operations_report()` y, si algo necesita revisión, escribe a los operadores activos por SMTP. Lo revisa:

- el almacenamiento del proyecto y el tamaño de la base: «Revisar» desde el 80 % y «Urgente» desde el 95 % de lo que da el plan;
- los trabajos fallidos en las últimas 24 h;
- el trabajo que espera más de 15 min, que es «Urgente» porque el ejecutor no se está despertando;
- los municipios al 80 % de una cuota.

Sin nada que revisar no se envía nada. El registro de Vercel deja una línea `operations.daily_report` con los avisos y el resultado del envío. El mismo resumen está en `/plataforma`, «Estado de la plataforma».

## Activar el ejecutor (una sola vez por ambiente)

Hace falta una contraseña para el rol y un secreto para el aviso. Los generas tú y **nunca** van al repositorio ni a un chat. En PowerShell, cada uno así (64 caracteres hexadecimales):

```powershell
$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString("x2") })
```

1. **Supabase → SQL Editor** (reemplaza los dos valores):

   ```sql
   alter role rikuy_worker with login password '<CONTRASEÑA_DEL_EJECUTOR>';
   select vault.create_secret('https://rikuy-app.vercel.app/api/jobs/drain', 'rikuy_job_runner_url');
   select vault.create_secret('<SECRETO_DEL_AVISO>', 'rikuy_job_runner_secret');
   ```

2. **Supabase → Connect → Transaction pooler**: copia la cadena de conexión y cambia el usuario `postgres.<ref>` por `rikuy_worker.<ref>` y la contraseña por la del paso 1:
   `postgresql://rikuy_worker.<ref>:<CONTRASEÑA_DEL_EJECUTOR>@<host-del-pooler>:6543/postgres`

   Usa una contraseña solo con letras y números: `#`, `/`, `?` o `%` rompen la dirección (o escríbelos codificados: `%23`, `%2F`, `%3F`, `%25`).

3. **Vercel → Settings → Environment Variables** (Production, marcadas como **Sensitive**):
   - `WORKER_DATABASE_URL` = la cadena del paso 2;
   - `JOB_RUNNER_SECRET` = el mismo secreto del aviso del paso 1.
4. **Redeploy** de producción.
5. **Comprobar:** panel → «Trabajos en segundo plano» → «Probar el ejecutor» (normal). En unos segundos pasa a «Terminado». «Procesar la cola ahora» ya no dice «no está configurado».

Para cambiar el secreto: actualízalo en Vault (`select vault.update_secret((select id from vault.secrets where name = 'rikuy_job_runner_secret'), '<NUEVO>');`) y en Vercel, y redespliega. Para cambiar la contraseña: otro `alter role` y la nueva cadena en Vercel.

## El panel: `/plataforma/trabajos`

Solo para operadores con el segundo factor verificado (para cualquier otra persona la página no existe).

- **Resumen:** en espera (y cuántos están listos), en curso, fallidos y terminados en las últimas 24 h.
- **Alarma:** si hay trabajos listos esperando más de 5 minutos, aparece un aviso: ningún ejecutor los está tomando.
- **Lista** filtrable por estado, con intentos, último error y «Ver intentos» (el historial completo).
- **Reintentar** (solo fallidos, con confirmación): crea una **ronda nueva** con los intentos en cero; las rondas anteriores quedan en el historial. Queda auditado (`job.replayed`).
- **Procesar la cola ahora:** corre el ejecutor unos 20 s desde el panel y muestra cuántos trabajos tomó y cómo terminaron.
- **Probar el ejecutor:** pone en la cola una prueba que no cambia ningún dato (`system.probe`) para un municipio. Tres modos: normal, «falla el primer intento» (ensayo de reintento) y «falla siempre» (ensayo de la cola de fallidos). Queda auditado (`job.probe_requested`).

## Qué hacer si…

**Aparece la alarma de trabajos esperando.** El ejecutor no se despierta o no llega a la base. En orden:

1. «Procesar la cola ahora». Si dice «no está configurado», faltan `WORKER_DATABASE_URL` o `JOB_RUNNER_SECRET` en Vercel (y un redeploy).
2. Vercel → Logs, filtra `/api/jobs/drain`: un 401 es un secreto distinto en Vault y en Vercel; `drain.failed` con `code` de PostgreSQL es la conexión (contraseña, usuario `rikuy_worker.<ref>`, puerto 6543).
3. Supabase → SQL: `select * from cron.job_run_details order by start_time desc limit 5;` (¿corre la tarea de cada minuto?) y `select status_code, error_msg from net._http_response order by created desc limit 5;` (¿qué respondió el endpoint?).

Mientras tanto no se pierde nada: los trabajos esperan en la base y salen cuando el ejecutor vuelve.

**Hay trabajos fallidos.** Abre «Ver intentos» y lee el código de error:

- `lease_expired`: el ejecutor dejó de responder a mitad (caída, despliegue, tiempo de la función agotado). Si se repite en el mismo trabajo, puede que no quepa en el tiempo de la función.
- `time_budget_exceeded`: el intento superó su presupuesto de tiempo.
- `no_processor` / `unsupported_schema_version`: el ejecutor desplegado no sabe hacer ese tipo o esa versión (un despliegue a medias). Reintenta tras desplegar.
- `unexpected_error`: un error sin clasificar del procesador; el mensaje dice cuál.
- Errores del propio procesador (`invalid_source`, `probe_failure`…): según su significado.

- En un modelo 3D: igual que en un panorama, más `missing_progress` (se borró una textura intermedia; se vuelve a codificar). Un GLB inválido, demasiado complejo o demasiado pesado tampoco es un trabajo fallido: queda «Rechazado» con su motivo.
- En un panorama: `storage_unavailable` (Storage no respondió; se reintenta solo y retoma desde el último nivel guardado) o `lease_lost`. Una foto que no es 360° o está dañada **no** es un trabajo fallido: el trabajo termina bien y el panorama queda «Rechazado» con su motivo en el panel del municipio.

Corrige la causa y luego «Reintentar». Reintentar sin corregir solo vuelve a fallar.

**Un trabajo quedó «En curso» mucho tiempo.** No hace falta tocarlo: cuando vence su arrendamiento, la próxima pasada del ejecutor (o del reconciliador) lo devuelve a la cola o, sin intentos, lo manda a fallidos.

**Quiero comprobar que todo funciona.** «Probar el ejecutor» en modo normal: debe pasar a «Terminado» en segundos. Para ensayar fallas, «falla el primer intento» (termina en el segundo) y «falla siempre» (termina en «Fallidos» tras 3 intentos; desde ahí se puede ensayar «Reintentar»).

## Cuotas y trabajos ([ADR-027](adr/ADR-027-usage-quotas.md))

- Cada panorama o modelo reserva 240 s de procesamiento del mes de su municipio al pedir la subida. Cuando su trabajo termina (bien o en «Fallidos»), se cuenta lo que duraron sus intentos y se libera el resto.
- «Reintentar» un trabajo en «Fallidos» suma el tiempo de los intentos nuevos, aunque el municipio ya no tenga cuota: es una decisión del operador.
- Diagnóstico (SQL, solo lectura):

  ```sql
  select resource, limit_amount, reserved, consumed, period_start
  from usage_buckets
  where tenant_id = '<id>'
  order by period_start desc;
  ```

  Las reservas de cada versión están en `usage_reservations`.

## Lo que no se hace

- Editar `background_jobs` o `job_attempts` a mano en producción: todo cambio pasa por las funciones (que validan el _fencing_) o por «Reintentar».
- Dar al ejecutor la clave secreta (`service_role`) o la sesión de una persona.
- Escribir URLs firmadas, tokens o contenido de archivos en mensajes de error o en registros.
- Usar la clave secreta de Supabase como secreto del aviso: viaja por la cola de `pg_net`.

## Pruebas

- `supabase/tests/database/013_job_ledger.test.sql` (pgTAP, 71 aserciones): permisos, idempotencia, reclamo con equidad y concurrencia, _fencing_, latido, puntos de control, reintentos, fallidos, presupuesto de tiempo, reintento a mano y auditoría.
- `packages/db/src/job-ledger.int.test.ts` — **D-01** contra PostgreSQL real, con varios ejecutores a la vez: un ejecutor que muere sin avisar, retomar desde el punto de control con el ejecutor viejo bloqueado, encolar duplicados al mismo tiempo, fallidos y reintento a mano, un municipio que satura la cola sin frenar a otro, y los límites del rol del ejecutor.
- `packages/core/src/application/jobs/jobs.test.ts` y `apps/worker/src/processors/*.test.ts`: el ejecutor de un trabajo (latido, pérdida del arrendamiento, presupuesto, errores), el drenaje, la sonda y la limpieza de subidas (reintento si Storage no responde, idempotencia tras una caída).
- `supabase/tests/database/014_job_runner.test.sql` (30 aserciones): permisos, tareas programadas, sin configuración no se llama a nadie, el barrido diario, la limpieza con el arrendamiento del trabajo (otro municipio no ve nada), el aviso con su secreto y a lo sumo uno cada 10 s.
- `supabase/tests/database/015_panoramas.test.sql` (35 aserciones): límites por propósito (50 MB panoramas, 10 MB fotos), quién sube y envía, nada se procesa antes de subir el original, un trabajo por panorama, lista por miembro y no de otro municipio, manifiesto solo en versiones listas y con forma válida, completar y rechazar solo con el arrendamiento vigente de un trabajo de panorama.
- D-01 suma un panorama completado por un segundo ejecutor tras vencer el arrendamiento del primero, que ya no puede escribir.
- `apps/worker/src/processors/process-panorama.test.ts` y `packages/db/src/panorama-renderer.test.ts`: con y sin teselas, rechazos, retomar desde el punto de control, sin URLs firmadas en los errores; con sharp real, vista previa ≤ 40 KB sin EXIF y teselas de 512 px.
- `supabase/tests/database/016_models.test.sql` (45 aserciones):
  - tipo y peso al subir (solo GLB y solo para modelos; las imágenes conservan sus tipos);
  - el camino síncrono de imágenes no completa un modelo;
  - quién envía y quién ve, con aislamiento entre municipios;
  - un trabajo por modelo;
  - el manifiesto: tope de 15 MB, sin rutas fuera de la carpeta y sin poster desde el pipeline;
  - el poster por rol y estado, con el arrendamiento vigente.
- D-01 suma un modelo que completa un segundo ejecutor tras vencer el arrendamiento del primero.
- `packages/db/src/model-optimizer.test.ts`: con Basis, Meshopt y Draco reales, sobre modelos sintéticos:
  - clasificación por uso;
  - textura compartida separada y señalada;
  - colores dentro de la tolerancia;
  - entrada en Draco;
  - archivos externos, extensiones desconocidas y archivos truncados rechazados.
  - Con `RIKUY_REAL_GLB=/ruta/modelo.glb`, también prueba un modelo real (nunca en el repositorio).
- `apps/web/e2e/model-colors.e2e.test.ts` (job «Contracts», con el Chrome del runner): el procesador y el optimizador reales, y luego el original y el optimizado dibujados por three.js desde la misma cámara deben verse iguales (ΔE de las superficies). La imagen comparada queda como artefacto del job.
- `apps/web/src/server/job-runner.test.ts`: el endpoint (503 sin configurar, 401 con otro secreto, 202 y drenaje después de responder) y los registros en JSON.
