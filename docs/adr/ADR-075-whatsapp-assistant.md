# ADR-075 — El asistente del municipio en WhatsApp

- **Estado:** Aceptada — 2026-11-28
- **Concreta:** A · Paso 6 (WhatsApp), como prototipo con el número de prueba de Meta
- **Se apoya en:** [ADR-021](ADR-021-visitor-location.md) (ubicación del visitante), [ADR-036](ADR-036-ai-gateway.md) (gateway de IA y huella del visitante), [ADR-038](ADR-038-visitor-assistant.md) (asistente del visitante), [ADR-041](ADR-041-assistant-voice.md) (voz), [ADR-053](ADR-053-unanswered-questions.md) (preguntas sin respuesta), [ADR-071](ADR-071-assistant-only.md) («Solo asistente») y [ADR-074](ADR-074-channel-metrics-faq.md) (métricas por canal)

## Contexto

El asistente ya llega por el portal, la web del municipio y los QR. En Bolivia casi todos los visitantes usan WhatsApp, y escribirle al número del municipio es más natural que abrir una página. Ninguna alcaldía tiene todavía su cuenta de Meta: el usuario quiere probarlo ya con su propia cuenta y el número de prueba que Meta da a cada app, y cambiarlo por el número real cuando una alcaldía lo contrate.

Desde el 15 de enero de 2026, Meta no permite chatbots de IA de uso general en su API. Un asistente limitado al turismo de un municipio y a lo que ese municipio publicó sí está permitido.

Decisiones del usuario (2026-11-28):

- **memoria:** los últimos 6 mensajes de la conversación, durante 24 horas;
- **tipos de mensaje:** texto, **notas de voz** (con la cuota de dictado) y **ubicación compartida** («¿Qué hay cerca?», la posición no se guarda);
- **números:** el operador de la plataforma registra el número de cada municipio en «Módulos»; una sola app de Meta para la plataforma, con su clave en Vercel;
- **fuentes:** los enlaces al final del mensaje.

## Decisión

### 1. Un número es de un municipio

1. **`whatsapp_numbers`**: el «identificador del número de teléfono» de Meta (solo números), su municipio y, opcional, el número como lo ven los visitantes («+591 67680091»). Hasta 3 por municipio; un número es de un solo municipio. RLS sin permisos: todo por funciones.
2. **Solo el operador con segundo factor** registra y quita números (`platform_add_whatsapp_number`, `platform_remove_whatsapp_number`, auditados). Cualquier miembro los ve (`tenant_whatsapp_numbers`) en «Asistente en tu web», con su enlace `wa.me` y un código QR.
3. Meta firma cada mensaje que reenvía; el municipio sale **del número al que se escribió, en la base**, nunca de lo que dice el mensaje. Un número que ningún municipio tiene no recibe respuesta.

### 2. El webhook

1. **`/api/whatsapp`** en el dominio de la plataforma. `GET`: Meta comprueba la suscripción con el token de verificación (comparación en tiempo constante). `POST`: el cuerpo se verifica con `X-Hub-Signature-256` (HMAC-SHA256 con el secreto de la app, sobre los bytes tal como llegaron) antes de leerlo; se responde 200 al momento y el mensaje se procesa después (`after()`), porque Meta reintenta lo que tarda.
2. **`ai_api.whatsapp_begin`** (solo `rikuy_ai`): el municipio del número, su dominio, la huella del remitente y la conversación. Cada mensaje se toma **una vez** (`whatsapp_inbound`, por el id de Meta): un reintento no se responde dos veces. Un municipio que no está en línea no responde; más de 5.000 mensajes en un día para un municipio, tampoco.
3. La clave de Meta, el secreto de la app y el token de verificación viven en el mismo módulo que la clave de Groq (`ai-gateway.ts`; ESLint lo impide en cualquier otro). Ni el mensaje, ni el número, ni la respuesta de Meta llegan a un error o un registro.

### 3. El mismo asistente

1. El mensaje se responde con **el mismo asistente del portal** (`askAssistant`), con la cuota del municipio y el límite de 10 preguntas por hora del visitante (ADR-036), con la huella como visitante.
2. **Notas de voz:** se descargan de Meta con la clave (hasta 2 MB) y pasan a texto como el dictado del portal, con su cuota de segundos (ADR-041), solo si el municipio tiene el módulo de voz. La respuesta empieza con «Entendí: «…»». Sin voz, lo dice y pide escribir.
3. **Ubicación compartida:** se miden en el servidor las distancias en línea recta a lo publicado y se pregunta «¿Qué hay cerca de donde estoy?» con esas distancias (ADR-039). La posición se usa una vez y no se guarda ni llega al modelo. Es la única excepción a ADR-021 (la posición se calcula en el dispositivo): en WhatsApp no hay dispositivo nuestro, y la visitante la envía ella misma, por mensaje.
4. Otro tipo de mensaje (foto, sticker, documento) recibe «Por ahora entiendo mensajes de texto, notas de voz y tu ubicación».
5. Cada respuesta se cuenta con el canal **«whatsapp»** (ADR-074), y la pregunta sin respuesta se guarda como en el portal (ADR-053).

### 4. La conversación, sin el número

1. **La huella del remitente** es un HMAC-SHA256 del municipio y su número con un secreto que solo leen las funciones de la base: estable durante la conversación, distinta en cada municipio, y nunca el número.
2. **`whatsapp_messages`** guarda los últimos 6 mensajes (pregunta y respuesta, enmascarados con la misma regla de ADR-053: correos, teléfonos, documentos y enlaces) durante **24 horas**. La tarea `rikuy-forget-whatsapp` (cada hora) los borra, y los ids de mensajes tomados a los 2 días.

### 5. El mensaje

1. Texto plano de WhatsApp (hasta 4.096 caracteres, cortado en una línea): la respuesta, el plan con sus paradas numeradas, y al final **«Fuentes:»** con un enlace absoluto por fuente. Con portal, a sus páginas; sin portal, a la web del municipio, o sin enlace (ADR-071).
2. «Quiero hablar con una persona» responde con «Atención al visitante» (ADR-073): su WhatsApp con la pregunta escrita, su teléfono y su correo.

### 6. Prototipo y producción

1. Para probarlo, la app de Meta del usuario con **el número de prueba** que Meta da a cada app (hasta 5 destinatarios verificados) y una clave temporal. Se registra en el panel como el número de Ucureña.
2. Para un municipio real: su número dedicado, un nombre visible aprobado por Meta, la cuenta de empresa verificada y una clave permanente (usuario del sistema). Cambiar de número es quitar uno y registrar otro en «Módulos»: no toca código.

## Consecuencias

- Un municipio con WhatsApp no necesita que el visitante abra nada: el mismo asistente, citado, por el canal que ya usa.
- Meta conoce los mensajes, como en cualquier chat de WhatsApp; la página de privacidad lo dice.
- Las notas de voz y la ubicación usan cuotas que ya existen; un municipio con mucho WhatsApp las agota antes, y el plan gratuito de Groq no alcanza para varios municipios: se cotiza con el municipio.
- Sin plantillas ni mensajes que inicie el municipio: solo se responde dentro de las 24 horas del mensaje del visitante, que no paga plantilla.
- Los costos de Meta (mensajes de servicio gratis por número y luego por mensaje) se confirman con Meta antes de cotizar un municipio real.
