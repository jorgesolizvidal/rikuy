# ADR-036 — Gateway de IA: rol propio, cuota diaria en tokens y degradación sin IA

- **Estado:** Aceptada — 2026-10-31
- **Concreta:** ADR-007, ADR-012, ADR-018, ADR-022 y el cierre de P0 (D4) para el roadmap P5 · Paso 1

## Contexto

El asistente del visitante (P5 · Paso 3) y el de administración (P5 · Paso 7) necesitan un único punto por donde pase toda llamada a un modelo. Ese punto tiene que contar lo que se usa, cortar a tiempo y dejar el portal funcionando cuando la IA no está.

Condiciones del piloto:

- Un solo modelo: `openai/gpt-oss-120b` en Groq (cierre de P0, D4).
- Solo planes gratuitos hasta tener contrato. El plan gratuito de Groq da **200.000 tokens y 1.000 pedidos por día**, y los límites son de la **organización**, no de cada clave: crear una clave por municipio no agrega capacidad.
- El usuario principal es un **visitante anónimo**. Una RPC llamable con la clave pública permitiría a cualquiera gastar la cuota de un municipio sin pasar por el portal. La clave secreta no puede usarse en peticiones ordinarias (CONTRIBUTING §1.3).
- El panel en producción valida los recursos de cuota con una lista cerrada. Si la migración llega antes que el nuevo despliegue web, un recurso nuevo en las lecturas actuales rompería «Uso del plan», `/plataforma` y el informe diario.

Decisiones del usuario (2026-10-31):

- **Una sola clave de Groq** para toda la plataforma (`rikuy-produccion`), solo en Vercel. Una clave por municipio queda como opción para planes comerciales en que el municipio pague su propia cuenta.
- **Cuota por municipio en tokens por día**, 40.000 por defecto y ajustable por el operador.
- **Un tope de la plataforma** al 90 % de lo que da Groq (180.000 tokens por día).
- **Un límite por visitante** de 10 preguntas por hora.
- **Una sola cuota por municipio** para el asistente del visitante y el de administración.
- **Nunca un error para el visitante:** con la cuota agotada o el proveedor caído, un mensaje amable con el nombre del asistente y enlaces útiles. El resto del portal no cambia.

## Decisión

1. **Rol propio de base de datos `rikuy_ai`.** Igual que el ejecutor con `rikuy_worker`, la IA se conecta directo a PostgreSQL con un rol sin permisos sobre tablas, que solo ejecuta el esquema `ai_api`. Se crea sin permiso de iniciar sesión; el operador lo habilita una vez en producción. Un solo módulo web abre esa conexión (`src/server/ai-gateway.ts`, impuesto por ESLint). Ni la clave pública ni la secreta pueden reservar ni gastar cuota de IA.
2. **Cuota `ai_tokens`** en las mismas tablas de cuotas (ADR-027), con período **diario a medianoche en la hora del municipio**. Las lecturas actuales (`tenant_usage`, `platform_tenant_usage` y el resumen de operaciones) siguen devolviendo solo almacenamiento y procesamiento. La IA tiene lecturas propias (`tenant_ai_usage`, `platform_ai_usage` y la clave `ai` del resumen): ningún consumidor existente ve un valor que no conoce.
3. **Reserva antes de llamar, liquidación después.** `ai_api.begin_request` hace, en una transacción:
   - revisar el municipio (suspendido, o no en línea para el asistente del visitante);
   - revisar el límite del visitante;
   - reservar tokens en la cuota del municipio y luego en el día de la plataforma.

   Lo que no cabe queda registrado como rechazado, con su motivo, sin reservar nada y sin llamar al proveedor. `ai_api.finish_request` cambia lo reservado por lo usado (idempotente) y guarda cada llamada al proveedor en `ai_executions`. La reserva es lo estimado de la entrada más el máximo de salida del perfil, así que el uso real casi nunca la supera. Si la supera, se cuenta igual, porque el trabajo ya se hizo.

4. **Reservas huérfanas.** Si el servidor muere entre la reserva y la liquidación, una tarea de `pg_cron` cada 15 minutos da por usada la reserva tras 10 minutos (lo prudente: Groq pudo haberla consumido). También borra lo viejo: pedidos de más de 90 días y sales de más de 2 días.
5. **Privacidad del visitante.** El servidor pasa una clave del visitante (en el Paso 3, su IP). La base la guarda solo como `sha256(sal del día ‖ municipio ‖ clave)`, con una sal aleatoria que cambia cada día (UTC) y que nadie puede leer. No se guarda el texto de las preguntas ni de las respuestas (ADR-022).
6. **Perfiles en el núcleo:**

   | Perfil      | Uso                         | Entrada máx. | Salida máx. | Tiempo máx. |
   | ----------- | --------------------------- | ------------ | ----------- | ----------- |
   | `assistant` | Asistente del visitante     | 6.000        | 1.000       | 20 s        |
   | `copilot`   | Asistente de administración | 12.000       | 2.000       | 30 s        |
   | `probe`     | «Probar la IA» del operador | 200          | 256         | 15 s        |

   La salida incluye el razonamiento breve del modelo: `gpt-oss` razona antes de responder, y se le pide esfuerzo bajo (`reasoning_effort: "low"`) y que no devuelva ese razonamiento. Los tres perfiles usan el mismo modelo (D4); cambiar de modelo es una variable (`AI_MODEL`). El proveedor es un puerto: Groq con su API compatible con OpenAI, sin SDK, y uno simulado para desarrollo y pruebas.

7. **Reintentos.** Un solo reintento ante una caída o un tiempo agotado del proveedor. Ante un 429 no se reintenta: Groq está saturado y reintentar empeora. Cada intento queda en `ai_executions`.
8. **Resultados degradados del núcleo:**
   - `tenant_quota`: «Por hoy ya respondí todas las preguntas que podía»;
   - `platform_quota`: el mismo mensaje, sin decir que es de la plataforma;
   - `visitor_limit`: «vuelve en un rato»;
   - `provider_unavailable`: «prueba en unos minutos»;
   - `tenant_unavailable` y `not_configured`: el asistente no está disponible.

   Cada uno trae el texto para el visitante con el nombre del asistente del municipio (o uno neutro), enlaces a Destinos, Agenda, Mapa y Tours, y el contacto de turismo de la marca.

9. **«Probar la IA» en `/plataforma`.** El operador (con segundo factor) manda una prueba mínima por el mismo gateway, a nombre de un municipio, y ve el resultado, el modelo, la latencia y los tokens. Sirve para comprobar la clave en producción y para ver una cuota agotada en acción.

## Consecuencias

- (+) Ningún camino público puede gastar la cuota de un municipio, y un municipio no puede gastarse la de otro.
- (+) La IA se apaga sola antes de que Groq rechace pedidos, y el portal no depende de ella.
- (+) Pasar al plan de pago de Groq es cambiar valores (cuota por defecto, tope de la plataforma y, si conviene, período mensual), no rehacer nada.
- (−) Otra conexión y otro rol que habilitar en producción, con una contraseña más que guardar.
- (−) La estimación de tokens de entrada es aproximada (caracteres / 3): reserva de más, nunca de menos en la práctica.
- (−) El límite por visitante se reinicia a medianoche UTC, cuando cambia la sal.
