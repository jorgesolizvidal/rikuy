# ADR-073 — Pasar a una persona: «Hablar con una persona»

- **Estado:** Aceptada — 2026-11-27
- **Concreta:** A · Paso 4 (pasar a una persona)
- **Se apoya en:** [ADR-038](ADR-038-visitor-assistant.md) (asistente del visitante), [ADR-039](ADR-039-assistant-plans.md) (horario de atención), [ADR-053](ADR-053-unanswered-questions.md) (lo que preguntan los visitantes), [ADR-069](ADR-069-useful-knowledge.md) (WhatsApp de los servicios) y [ADR-071](ADR-071-assistant-only.md) (el asistente en la web del municipio)

## Contexto

El asistente responde con lo publicado y, cuando no sabe, lo dice y muestra el teléfono o el correo del portal (ADR-053). Pero el visitante no tiene una forma clara de pedir que lo atienda una persona, y el municipio no sabe qué preguntas terminaron en una consulta a su oficina. En Bolivia esa consulta casi siempre es por WhatsApp, que la marca del portal no tiene.

Decisiones del usuario (2026-11-27):

- **«Atención al visitante» en «Marca del portal»:** un nombre (por ejemplo, «Oficina de turismo»), un WhatsApp y el horario de atención. Sin él, se usan el teléfono y el correo del portal;
- **siempre a la vista y cuando no sabe:** un botón «Hablar con una persona» en el asistente; además aparece solo cuando el asistente no sabe la respuesta y cuando el visitante escribe «quiero hablar con una persona»;
- **el mensaje va escrito:** el enlace de WhatsApp se abre con «Hola, vi el portal de… Mi consulta: …» y la última pregunta del visitante. Lo envía el visitante; nada pasa por Rikuy;
- **se guarda la pregunta, marcada «pidió una persona»,** en «Lo que preguntan los visitantes»: enmascarada y por 90 días, como las preguntas sin respuesta, aunque el asistente la haya respondido.

## Decisión

### 1. «Atención al visitante» en la marca

1. La marca acepta **`helpDesk`**, opcional: `{ name (1–60), whatsapp?, hours? }`. El WhatsApp es un número internacional (`+591 …`, como el de los servicios, ADR-069) y el horario tiene la forma de ADR-039. `private.is_valid_presentation` lo revalida; las marcas sin él siguen siendo válidas.
2. **El contacto del asistente** es el de «Atención al visitante» más el teléfono y el correo del portal. Sin `helpDesk`, se llama «el equipo del municipio» y solo tiene el teléfono y el correo. Sin ninguno de los tres medios, no hay botón ni tarjeta.
3. El contacto viaja con la página (el portal lo tiene en la marca publicada): mostrarlo no le pide nada al servidor.

### 2. Cuándo aparece

1. **Botón «Hablar con una persona»** debajo de los planes, en el portal, en la página «Pregúntale a…» y en la web del municipio (ADR-071).
2. **Solo, al final de la respuesta,** cuando el asistente no sabe (sin fuentes publicadas) y en los avisos de cuota o del proveedor.
3. **Escrito:** «quiero hablar con una persona», «¿puedo hablar con alguien?», «pásame con un humano», «talk to a person»… El servidor lo reconoce antes de llamar al modelo y responde `handoff`, sin gastar cuota. «¿Qué personas famosas nacieron aquí?» sigue siendo una pregunta.

### 3. La tarjeta

1. **«Hablar con {nombre}»**, el horario con «Abierto ahora · cierra a las 18:00» calculado en el navegador, y los botones **«Escribir por WhatsApp»**, **«Llamar»** y **«Escribir un correo»** según lo que tenga el municipio.
2. **El mensaje va escrito:** «Hola, vi el portal de {nombre del portal}. Mi consulta: {pregunta}». Sin pregunta, «Hola, vi el portal de {nombre del portal} y tengo una consulta.». En inglés si la conversación es en inglés. WhatsApp con `wa.me/{número}?text=…`; el correo con su asunto y el mismo texto. La pregunta es la última que el visitante escribió **antes** de pedir una persona.
3. La tarjeta dice que el mensaje lo envía el visitante y que lo lee el equipo del municipio.

### 4. Lo que se guarda

1. **Al tocar** WhatsApp, «Llamar» o el correo (no al ver la tarjeta), el navegador avisa a **`POST /asistente/persona`** con la referencia de la respuesta (`ref`, el pedido del gateway), la pregunta y la página. Una vez por respuesta.
2. **`ai_api.record_person_request`** (solo `rikuy_ai`) la guarda si el pedido es del asistente de este municipio, de la última hora y **del mismo visitante** (la misma huella diaria de ADR-036). Si esa pregunta ya estaba guardada como sin respuesta, la marca; si no, la guarda como **respondida y «pidió una persona»**. Mismo enmascarado, mismo tope diario y mismo olvido a los 90 días que ADR-053.
3. **`unanswered_questions`** suma `answered` y `asked_person_at`. Todo lo que ya la leía (el informe mensual, las recomendaciones del Copilot, el resumen del panel) **sigue contando solo las sin respuesta**.
4. Nada del visitante: ni su número, ni lo que escribe en WhatsApp, ni a quién llamó.

### 5. En el panel

1. **«Lo que preguntan los visitantes»** suma «Pidieron hablar con una persona»: cuántas veces, cuántas personas, las preguntas agrupadas (las respondidas también, marcadas) y, en la lista de las sin respuesta, cuántas veces cada una terminó en una persona.
2. **«Marca del portal»** suma el bloque «Atención al visitante» (nombre, WhatsApp y el horario del editor de destinos).

## Consecuencias

- **Gana:** el visitante siempre tiene a quién recurrir y llega con su consulta escrita; el municipio ve qué preguntas necesitaron una persona, también las que el asistente creía haber respondido.
- **Costo:** un bloque más en la marca, dos columnas, una función y una ruta; la tarjeta vive en el panel del asistente, que ya se descarga al abrirlo.
- **Límites:** no se sabe si el visitante envió el mensaje (solo que tocó el botón); una pregunta hecha más de una hora antes no se guarda; no hay derivación con un operador en vivo ni horario de feriados (la nota del horario lo cubre).
