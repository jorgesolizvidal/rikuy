# ADR-065 — El asistente con el sistema de diseño: tarjetas de lugares y del plan, cabecera y botón redondo

- **Estado:** Aceptada — 2026-11-14
- **Concreta:** C3 · Paso 6 (asistente)
- **Se apoya en:** [ADR-038](ADR-038-visitor-assistant.md) (asistente del visitante), [ADR-039](ADR-039-assistant-plans.md) (planes), [ADR-057](ADR-057-passport-stamps.md) (sellos en el teléfono), [ADR-061](ADR-061-portal-themes.md) (temas) y [ADR-050](ADR-050-portal-media-same-origin.md) (fotos desde el portal)

## Contexto

El diseño del usuario en Google Stitch muestra el asistente con una cabecera con su cara, una bienvenida, consultas frecuentes con íconos, respuestas con tarjetas de lugares y de ruta, y una barra para escribir con el micrófono a la vista. También inventa lo que Rikuy no tiene, y eso no se copia: «en línea», el cambio a quechua, «Validado por ancianos e historiadores», la «Guía de voz en vivo», los relatos en audio, «Activar guía GPS», un local que nadie publicó y «Validar con QR» en el chat.

Decisiones del usuario (2026-11-14):

- **tarjetas en las respuestas:** lugares con foto, el plan como tarjeta y el sello del pasaporte en los lugares;
- **cabecera con el logo y bienvenida**, y las sugerencias bajo «Preguntas frecuentes»;
- **en la PC, el panel lateral** de siempre, un poco más ancho;
- **en el celular, un botón redondo** sobre la barra inferior.

## Decisión

1. **Las tarjetas salen de lo publicado, nunca del modelo.** `POST /asistente` agrega a la respuesta `places`: por cada destino o evento citado como fuente y por cada parada de un plan, su título, su categoría, la fecha (eventos), la portada desde `/medios/…` (ADR-050), si tiene tour 360° y, si es parada de un circuito publicado, el lugar donde se guarda su sello. Lo arma el servidor del portal con las lecturas que ya tiene (destinos, eventos, índice, tours y pasaporte). Un lugar que no está publicado (un evento que terminó) no tiene tarjeta: queda su enlace en texto. Si algo falla, la respuesta sale igual, sin tarjetas.
2. **El sello sigue al teléfono:** la tarjeta dice «Sello del pasaporte» o «✓ Sellado en tu pasaporte», leído en el navegador (ADR-057). Nada sobre los sellos llega al servidor.
3. **El plan como tarjeta.** En «Plan para hoy» y «Ruta sugerida» con dos paradas o más, el motor (ADR-039) da un resumen: paradas, el recorrido entre ellas en línea recta y el tiempo a pie estimado (`AssistantPlan.summary`). La tarjeta suma la portada de la primera parada con un velo oscuro bajo el título, los sellos que da el recorrido (y cuántos ya tiene el teléfono) y «Ver la ruta en el mapa». «Qué hay cerca» no tiene resumen: cada distancia es desde el visitante, no un recorrido.
4. **Cabecera y bienvenida:** la cara del asistente es el logo del municipio (o sus iniciales), con su nombre y «Responde con lo publicado» (lo que hace, no un estado inventado). El saludo es una tarjeta de bienvenida, las sugerencias van bajo «Preguntas frecuentes» con íconos, y cada respuesta lleva la cara al lado. «Nueva conversación» pasa a un botón de ícono con su nombre accesible.
5. **Botón para abrirlo:** en el celular, un círculo con el ícono sobre la barra inferior; el nombre del asistente sigue en su nombre accesible. En la PC conserva el nombre. El panel lateral pasa de 26 a 28 rem.
6. **Estilos:** en `assistant.css`, que solo se descarga con el panel; usan los radios, las letras y los colores del tema (ADR-061).

## Consecuencias

- Una respuesta pesa un poco más (las tarjetas de sus lugares); las fotos se piden solo cuando aparecen en la conversación (`loading="lazy"`).
- La conversación guardada en el teléfono (24 h) incluye las tarjetas: un lugar que cambió de foto se ve con la anterior hasta la próxima pregunta.
- Las respuestas de antes de este paso se siguen viendo, sin tarjetas.
