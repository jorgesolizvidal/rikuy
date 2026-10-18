# ADR-022 — Asistente turístico del portal: una sola conversación, persona por municipio y voz

- **Estado:** Aceptada — 2026-10-17
- **Concreta:** ADR-007, ADR-018 y el cierre de P0 (D4–D7) para el portal del visitante
- **Origen:** revisión de paridad con el sistema anterior ([paridad funcional](../paridad-funcional.md))

## Contexto

En el sistema anterior el asistente del visitante se llama **Chaski** y tiene dos superficies con conversaciones separadas: el asistente general (plan para hoy, qué hay cerca, ruta sugerida, preguntas libres) y el guía virtual dentro de los tours 360°. Ambos aceptan dictado por voz y leen las respuestas en voz alta. El roadmap de Rikuy mencionaba «IA turística» y «guía contextual de escena/hotspot», pero no describía estas funciones y dejaba la voz para E3.

Rikuy es white-label: ningún nombre de municipio ni de su asistente puede estar en el código (CONTRIBUTING §1.2).

## Decisión

1. **Un solo asistente del visitante** con **una conversación** que conoce el contexto: página actual, destino o evento abierto, tour/escena/hotspot y, si el visitante la compartió, su ubicación redondeada ([ADR-021](ADR-021-visitor-location.md)). El servidor resuelve esos IDs y valida que pertenecen al municipio y a una revisión publicada; el cliente no aporta descripciones canónicas.
2. **Funciones del piloto (P5):** preguntas libres con citas; «qué hay cerca»; «plan para hoy» y «ruta sugerida» generados por un **motor determinista** (distancia, horario, vigencia) que el modelo solo explica; guía dentro del tour («¿Qué estoy viendo?»); acciones como enlaces validados contra el registro de rutas del portal; abstención cuando falta evidencia; respuesta en el idioma del visitante (español o inglés).
3. **Persona por municipio:** el nombre, el saludo y el tono del asistente son datos de la marca del municipio (`TenantPresentation`), versionados como el resto. Sin nombre configurado, el portal usa uno neutro. **«Chaski» es la configuración de Ucureña**, no un valor del código.
4. **Voz en P5** (antes E3): dictado mediante el gateway con un proveedor intercambiable y cuota de segundos por municipio (`ai_executions`); lectura en voz alta con la síntesis del navegador (sin costo). Si el dictado falla o no hay permiso de micrófono, queda el campo de texto.
5. **Privacidad:** la conversación vive en el dispositivo (máximo 24 h) y no se persiste en el servidor por defecto; las métricas guardan uso y latencia, no el texto ni la ubicación.

## Consecuencias

- (+) Paridad con el sistema anterior y se resuelve su problema conocido de dos hilos separados.
- (+) Cada municipio tiene su asistente con identidad propia sin tocar código (ZC-01).
- (−) El dictado agrega costo por segundo y otra capacidad que evaluar en A-01 (casos con audio).
- (−) La síntesis del navegador varía entre dispositivos; se elige la voz de forma determinista por idioma.
