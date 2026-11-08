# ADR-044 — Métricas por municipio para el operador

- **Estado:** Aceptada — 2026-11-07
- **Concreta:** ADR-012 y ADR-018 para el roadmap P6 · Paso 2 (criterio 8 del gate)

## Contexto

El criterio 8 del gate pide, por municipio, «errores/request ID, latencias de rutas y medios, backlog/fallos de jobs, uso/coste/cuota IA, integridad de publicación», y que el panel no muestre cifras sin fuente.

Lo que ya existía:

- **Trabajos:** el ledger guarda cada trabajo y cada intento, con su municipio, duración y resultado (ADR-014/019).
- **IA:** `ai_executions` guarda por llamada los tokens, los segundos de audio, la latencia y el estado (ADR-036/041).
- **Auditoría:** `audit_events` registra cada acción con su municipio.

Lo que faltaba:

- **Un ID de petición.**
- **Un registro de errores:** en Vercel Hobby los registros duran una hora.
- **Latencias de las rutas y de los medios por municipio.**
- **Un costo**, aunque sea estimado: el plan gratuito de Groq cuesta 0.
- **Un control de que lo publicado está completo.**

Decisiones del usuario (2026-11-07):

- **registro propio de errores** en la base, con un ID por petición;
- **latencias resumidas por hora** en las rutas que atiende el servidor, más una **sonda diaria** de cada portal y de un archivo de medios;
- **costo estimado** con la tarifa pública de Groq, guardando qué tarifa se usó;
- **integridad diaria y con un botón** del operador.

## Decisión

### ID de petición

- El proxy genera un UUID por petición y lo pasa a la aplicación como cabecera interna (`x-rikuy-request-id`): una cabecera entrante con ese prefijo se descarta, así que nadie lo inyecta.
- Lo devuelve en la respuesta como `X-Rikuy-Request-Id`, también en las páginas en caché.

### Errores

- `onRequestError` (instrumentación de Next.js) registra todo error del servidor (páginas, rutas y acciones) en `request_errors`:
  - el municipio, leído del contexto que puso el proxy en el portal o de la dirección `/o/{slug}` en el panel;
  - la superficie (portal, panel, plataforma), el patrón de la ruta (no la dirección real), el método, el ID de petición, el `digest` de Next.js, el tipo de error y su mensaje recortado (sin lo que sigue a `?` y hasta 300 caracteres).
- No guarda cuerpos, cabeceras, IP ni correos. Se conserva 30 días.
- Las páginas de error del portal y del panel muestran el `digest` como «Código de referencia». Con él, el operador encuentra el error en el panel.
- Las rutas propias que responden un error controlado no son errores del servidor y no se registran.

### Latencias

- Las rutas que atiende el servidor en cada pedido de un visitante se miden y se **resumen por municipio, hora y ruta**:
  - el asistente (`/asistente`);
  - el dictado;
  - los lugares del asistente;
  - los lugares del mapa;
  - los datos del recorrido.
- Cada resumen guarda los pedidos, los errores (5xx), el tiempo total y un histograma de 9 tramos (≤ 50, 100, 200, 400, 800, 1.600, 3.200, 6.400 ms y más). El p50 y el p95 se leen del histograma: son el **límite superior del tramo** que los contiene, y así se dice en el panel.
- No se guarda cada petición. La escritura ocurre después de responder (`after()`). Una falla al escribir nunca afecta al visitante.
- Las páginas en caché no pasan por la aplicación en cada visita. Por eso la **sonda diaria** (`metrics.probe_portal`, un trabajo por municipio en línea) pide desde la región de la función:
  - el inicio del portal (caché);
  - `/mapa` (lee la base);
  - un archivo público de medios del municipio, si tiene.

  Guarda el estado, el tiempo hasta el primer byte, el total, el peso y si salió de la caché.

- Las páginas del panel solo registran sus errores, no su latencia.

### Trabajos

Del ledger, por municipio y período: encolados, terminados, fallidos, en la cola de fallidos, la espera más larga de un trabajo listo y la duración p95 de los intentos por tipo.

### IA

- `ai_prices` guarda tarifas **versionadas**: proveedor, modelo, USD por millón de tokens de entrada y de salida, USD por hora de audio, desde cuándo vale y la fuente.
- Un trigger completa en cada fila nueva de `ai_executions` el **costo estimado** y la versión de tarifa usada.
- Primera tarifa, `groq-2026-10`:
  - `openai/gpt-oss-120b`: 0,15 / 0,60 USD por millón de tokens;
  - `whisper-large-v3-turbo`: 0,04 USD por hora de audio.

  Groq no deja leer su página de precios desde el entorno de desarrollo, así que las cifras salen de una página de referencia del 13 de octubre de 2026. La fuente queda en la fila.

- La migración completa el costo de las llamadas ya registradas con esa tarifa.
- Sin tarifa (el proveedor simulado), el costo queda vacío y el panel dice «sin tarifa».
- El panel muestra el **plan actual (gratuito): 0 USD** junto a lo que costaría con la tarifa de pago, y nunca suma lo uno con lo otro.

### Integridad de lo publicado

`private.check_publication` revisa un municipio solo con SQL, porque `storage.objects` está en la misma base. Revisa:

- **contenido publicado:** cada portada y foto tiene su copia pública en `media-public`;
- **tours publicados:** cada archivo que nombra su manifiesto existe. Son la vista previa, la imagen, **cada tesela** de cada nivel (`{carpeta}{nivel}/{col}_{fila}.webp`), el modelo y su poster, y las fotos de sus puntos;
- **marca activa:** su logo tiene copia pública;
- **asistente:** cada revisión publicada de contenido y de tour está leída (`knowledge_indexed_revisions`). Si se publicó hace menos de 15 minutos, cuenta como «leyéndose», no como problema.

El resultado se guarda en `publication_checks`: qué revisó, cuántos, los problemas (hasta 200, con tipo, título y archivo) y cuánto tardó. Corre cada día para los municipios en línea (`rikuy-check-publication`, 07:57 UTC) y cuando el operador pulsa «Revisar ahora». Se conserva 30 días.

### Escritura y lectura

- Las escrituras de telemetría (errores, latencias y sondas) usan la conexión del ejecutor (`rikuy_worker`) por funciones de `worker_api`. Ni la clave pública ni la de un usuario pueden escribir métricas falsas. Solo `src/server/telemetry.ts` y `src/server/job-runner.ts` abren esa conexión; ESLint lo impide en cualquier otro módulo.
- Sin `WORKER_DATABASE_URL` no se registra nada y la aplicación funciona igual.
- Leen solo los operadores con segundo factor:
  - `platform_metrics_overview` (todos los municipios);
  - `platform_tenant_metrics` (uno, con sus fuentes y períodos);
  - `platform_tenant_errors` (los últimos errores, con filtro por ID de petición o código de referencia);
  - `platform_check_publication` («Revisar ahora»).

  Los errores sin municipio (plataforma) aparecen aparte.

- **Cada cifra del panel lleva su fuente** (tabla o registro) **y su período** (24 h o 7 días, sobre el reloj de la base; la sonda y la integridad, con la hora de su última corrida).

## Consecuencias

- Criterio 8 cubierto con datos propios, por municipio y con fuente.
- Unas escrituras pequeñas más por pedido en las rutas medidas, después de responder. A un ritmo del piloto (menos de 10.000 pedidos medidos por día) son menos de 1 MB por mes.
- El p50/p95 de las rutas es aproximado (por tramos). La sonda mide desde la región de la función (São Paulo), no desde el teléfono del visitante; para eso están Speed Insights y la medición en Android.
- Cuando cambie la tarifa de Groq, se agrega una fila nueva con su fecha (migración). El costo ya calculado no cambia.
