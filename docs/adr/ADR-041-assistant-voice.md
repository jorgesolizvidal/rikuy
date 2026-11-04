# ADR-041 — Voz del asistente: dictado con Groq Whisper y cuota de segundos, lectura con la voz del navegador

- **Estado:** Aceptada — 2026-11-03
- **Concreta:** ADR-022 (punto 4) y ADR-036 para el roadmap P5 · Paso 6

## Contexto

En el sistema anterior, el asistente aceptaba dictado y leía sus respuestas en voz alta, sin límite de uso (auditoría, SEC-07). ADR-022 adelantó la voz a P5 con tres condiciones:

- el dictado pasa por el gateway con un proveedor intercambiable y una **cuota de segundos por municipio**;
- la lectura usa la síntesis del navegador, sin costo;
- sin micrófono o con el proveedor caído, el asistente sigue por texto.

Hechos:

- El plan gratuito de Groq transcribe hasta **7.200 s de audio por hora y 28.800 s por día** (20 pedidos por minuto y 2.000 por día) con `whisper-large-v3-turbo`. Cobra **al menos 10 s** por pedido. Acepta webm, ogg, mp4/m4a, wav, mp3 y flac.
- Los navegadores graban así: Chrome y Firefox en Opus (webm u ogg), Safari en AAC dentro de MP4. Unos 30 s de voz comprimida pesan 120–500 KB.
- El reconocimiento de voz propio del navegador (Web Speech) en Chrome envía el audio a Google, no existe en Firefox y falla en algunos Android.

Decisiones del usuario (2026-11-03):

- **Groq Whisper** transcribe el dictado, con la misma clave de Groq.
- **El texto queda para revisar:** aparece en el campo de la pregunta y el visitante pulsa «Enviar».
- **Botón «Escuchar» en cada respuesta**, y lectura automática si la pregunta se dictó.
- **30 min de dictado por día por municipio** por defecto, ajustables por el operador. Tope de la plataforma de **25.900 s por día** (el 90 % del plan gratuito). **10 dictados por hora** por visitante. **30 s** como máximo por dictado.

## Decisión

1. **Un recurso de cuota nuevo, `ai_audio_seconds`**, diario en la hora del municipio, en las mismas tablas de ADR-027 (1.800 s por defecto).
   - El tope de la plataforma va en `ai_platform_days` (columnas `limit_audio_seconds`, `audio_reserved`, `audio_consumed`) y se cuenta por día UTC, como los tokens.
   - Las lecturas que ya existían (`tenant_usage`, `platform_tenant_usage` y las cuotas del resumen de operaciones) **siguen devolviendo solo almacenamiento y procesamiento**: ahora nombran esos dos recursos, así un recurso nuevo nunca llega a un panel que no lo conoce.
2. **Un dictado es un pedido del gateway con su propio perfil (`dictation`)** en `ai_requests`, que cuenta segundos y no tokens (lo revalida la base):
   - `ai_api.begin_dictation` (solo `rikuy_ai`) revisa en una transacción que el municipio esté en línea, los dictados del visitante en la última hora (10, aparte de sus 10 preguntas), los segundos del municipio y los de la plataforma. Reserva **30 s**; lo que no cabe queda rechazado sin reservar nada;
   - `ai_api.finish_dictation` liquida con los segundos que cobró el proveedor (al menos 10, redondeados hacia arriba) y registra cada llamada en `ai_executions.audio_seconds`;
   - `finish_request` no liquida un dictado, y `finish_dictation` no liquida una pregunta;
   - una reserva abierta más de 10 min se cuenta como usada, como las de tokens.
   - **Nunca se guardan el audio ni el texto.**
3. **El caso de uso `transcribeDictation`** (`@rikuy/core`):
   - reconoce el audio por sus primeros bytes, no por lo que dice el navegador. Rechaza lo que no es audio, lo de menos de 512 bytes y lo de más de 2 MB antes de reservar;
   - reserva, llama al proveedor (un reintento si está caído o lento, ninguno ante un 429) y liquida;
   - antes de mostrar el texto, quita los segmentos que el proveedor marca como sin voz, las frases que Whisper inventa en el silencio («Subtítulos realizados por…», «Gracias por ver el video») y el texto de ayuda leído de vuelta. Si no queda nada: «No te escuché bien»;
   - al proveedor le pasa como ayuda (`prompt`) **solo nombres**: el del sitio y los de los destinos y eventos publicados, para que escriba bien «Ucureña» o «Laguna Espejo». No lleva instrucciones.
4. **`POST /asistente/dictado`** en el host del portal, con el mismo control que `/asistente`: municipio por el host, `Origin` del mismo portal, tipo `audio/*`, hasta 2 MB leídos por partes y `no-store`. Devuelve el texto o un mensaje corto; nunca un error que corte la conversación.
5. **El navegador** (en el panel, que se descarga al abrirlo; nada nuevo en las páginas):
   - el botón del micrófono aparece solo si el navegador puede grabar (`MediaRecorder`, contexto seguro). Graba hasta 30 s mientras dice «Escuchando… n s de 30», y se detiene al tocarlo otra vez o con Escape, que descarta la grabación;
   - el texto llega al campo de la pregunta con «Revisa el texto y pulsa «Enviar»». **Nunca se envía solo**;
   - sin permiso, sin micrófono, con la cuota agotada o con el proveedor caído, aparece un mensaje junto al campo y se sigue escribiendo;
   - **«Escuchar»** en cada respuesta y aviso lee el texto con la voz del dispositivo (`speechSynthesis`), en el idioma de la respuesta. La voz se elige de forma determinista: primero el español de Bolivia o de Latinoamérica, después cualquier voz del idioma. El texto se lee en partes cortas, porque algunos navegadores cortan las lecturas largas. Las fuentes y los enlaces no se leen;
   - si la pregunta se dictó, la respuesta se lee sola. Escribir, cerrar el panel o empezar otra conversación detiene la lectura.
6. **`Permissions-Policy`** pasa a `microphone=(self)`: solo el propio origen, y solo con el permiso del visitante.
7. **Panel:**
   - «Uso del plan» suma «Dictado por voz» con lo usado del día;
   - «Cuotas por municipio» permite cambiarlo en minutos por día;
   - «Asistente con IA» en `/plataforma` muestra el dictado de la plataforma en el día y en las últimas 24 h;
   - el informe diario avisa al 80 % de la plataforma o de un municipio.

## Consecuencias

- (+) Se cumple el criterio del paso: sin micrófono, sin permiso, sin cuota o con el proveedor caído, el asistente sigue por texto. Lo comprueba el e2e con un micrófono simulado en Chromium.
- (+) El dictado no puede pasar ningún límite (municipio, plataforma, visitante), aunque lleguen varios a la vez. Ni el audio ni el texto quedan en ningún lado.
- (+) Leer en voz alta no cuesta nada ni sale del dispositivo.
- (−) Cada dictado cuenta al menos 10 s, aunque dure 2 s: con 30 min por día, un municipio tiene unos 180 dictados cortos.
- (−) La calidad de la lectura depende de las voces instaladas en el dispositivo. En un teléfono sin voz en español, la lectura usa la voz por defecto.
- (−) Whisper detecta el idioma solo. La ayuda de nombres en español puede inclinarlo hacia el español con una pregunta en inglés muy corta.
- (−) El texto pasa por un proveedor externo (Groq). La página de privacidad lo dice.
