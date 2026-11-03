# ADR-039 — Planes del asistente: «qué hay cerca», «plan para hoy» y «ruta sugerida» con un motor determinista y horario de atención

- **Estado:** Aceptada — 2026-11-03
- **Concreta:** ADR-021, ADR-022 y ADR-038 para el roadmap P5 · Paso 4

## Contexto

El asistente del visitante (Paso 3) responde preguntas con lo publicado. Faltan las tres preguntas que el sistema anterior tenía como botones: «qué hay cerca», «plan para hoy» y «ruta sugerida».

Condiciones:

- **Criterio del paso:** ningún evento terminado ni lugar cerrado recomendado como vigente. Un modelo de lenguaje no puede garantizarlo: confunde fechas, inventa horarios y no sabe qué hora es.
- La posición del visitante no sale del dispositivo (ADR-021, RC-06).
- Los destinos no tenían **horario de atención**: sin él, «plan para hoy» no puede saber si un lugar está abierto.
- Groq gratuito: 8.000 tokens por minuto para toda la plataforma (ADR-036).

Decisiones del usuario (2026-11-03):

- **Horario opcional** en los destinos, en este paso: días y horas, o «siempre abierto». La ficha muestra «Abierto ahora / Cerrado». Los planes solo recomiendan lugares abiertos; un lugar sin horario entra con el aviso «confirma el horario».
- **Se calcula en el celular:** el teléfono envía solo a qué lugares y a qué distancia está; la posición nunca sale del dispositivo.
- **En el chat y en el mapa:** una lista ordenada con distancias y tiempos a pie en la conversación, y «Ver la ruta en el mapa», que abre `/mapa` con los puntos numerados unidos por una línea.

## Decisión

1. **Horario en la revisión del destino.** `content_revisions.opening_hours` (jsonb, opcional):
   - `{"mode": "always", "note": ""}`;
   - o `{"mode": "weekly", "days": [7 días desde el lunes, cada uno con hasta 2 rangos ["HH:MM", "HH:MM"]], "note": ""}`.

   Hora local del municipio. Un rango abre antes de cerrar dentro del día («24:00» cierra a medianoche; sin rangos que pasen la medianoche); el segundo empieza después del primero; al menos un rango. La base lo valida (`private.is_valid_opening_hours`, con un `check` en la columna), se sella con la revisión y vuelve con «Volver a esta versión».

   `revision_document` agrega la clave `hours` **solo cuando hay horario**: un documento sin horario es igual que antes, así el panel ya desplegado no se rompe mientras se actualiza.

   Lectura anónima `portal_opening_hours` (solo destinos publicados de municipios en línea). El indexador lo agrega al texto del destino («Horario de atención: …»), así las preguntas libres también lo encuentran.

2. **Motor determinista en `@rikuy/core`** (`domain/plan`), sin IA:
   - **«Qué hay cerca»:** destinos abiertos ahora (o sin horario) y eventos en curso o que empiezan en la próxima hora y media, del más cercano al más lejano, hasta 5, a menos de 5 km.
   - **«Plan para hoy»:** hasta 5 paradas desde ahora hasta las 22:00, eligiendo cada vez la que menos camino y espera suma (un evento vale un poco más de camino: pasa una vez). Cada destino necesita al menos 30 minutos abierto al llegar; cada evento, 15 minutos por delante y no más de 90 de espera. Después de las 21:00, «ya es tarde».
   - **«Ruta sugerida»:** los lugares abiertos ahora más cercanos (hasta 6), en un orden corto (vecino más cercano y 2-opt), verificando cada parada a la hora de llegada.
   - **Las dos reglas valen para cualquier entrada** (pruebas con 400 casos aleatorios): un evento terminado nunca es una parada, y un destino con horario nunca es una parada mientras está cerrado. El servidor usa su propio reloj y los datos publicados, nunca lo que diga el navegador.
   - Tiempos a pie con la estimación de ADR-021 (línea recta × 1,3 a 4,5 km/h), redondeados a 5 minutos.
3. **Origen del plan:**
   - con la ubicación activada, el teléfono pide `GET /asistente/lugares` (claves y coordenadas públicas), mide la distancia en línea recta a cada lugar y envía `distances: {"destination:slug": metros}`. El servidor acepta solo claves de lugares publicados y **redondea a 100 m**;
   - sin ubicación, desde la ficha donde está el visitante o, si no, desde el lugar más cercano al centro de los destinos;
   - «qué hay cerca» sin ubicación ni ficha no llama al modelo: pide la ubicación con un botón, y la misma pregunta se repite sola cuando el teléfono la conoce;
   - a más de 15 km de todo (otra ciudad), «qué hay cerca» lo dice, y el plan y la ruta empiezan en el centro.
4. **Intención:** los botones del panel («¿Qué hay cerca?», «Plan para hoy», «Ruta sugerida») la envían explícita; una pregunta escrita se reconoce solo por frases claras en español e inglés («plan para hoy», «what's near me», «una ruta»). «¿Qué hay en la plaza?» sigue siendo una pregunta para lo publicado.
5. **El modelo solo explica:** una llamada (`[tarea:explicar]`, dentro del mismo pedido al gateway) recibe la lista ya decidida —nombres, horas y avisos, **sin distancias**: desde el visitante dirían dónde está— y escribe 2 a 4 frases. Si escribe una hora que el plan no tiene, se descarta y se muestra una frase fija. Sin IA (cuota, proveedor caído, límite del visitante), el plan se muestra igual con la frase fija.
6. **Respuesta estructurada:** `reply.plan` con título, desde dónde, paradas (enlace a la ficha, hora en el plan de hoy, distancia y tiempo a pie, avisos «Sin horario publicado: confírmalo», «Cierra a las 18:00», «Empieza a las 11:00») y `mapHref`. Los enlaces salen de `PORTAL_PATHS`, nunca del modelo.
7. **Ruta en el mapa:** `/mapa?ruta=destination:plaza,event:feria` (hasta 6 claves). La página toma solo los lugares que siguen publicados y vigentes, en ese orden: pines numerados, una línea discontinua «en línea recta» y la lista en el mismo orden (la alternativa accesible), con «Quitar la ruta». Una clave desconocida o de otro municipio se ignora.
8. **Gold:** 6 casos nuevos (G41–G46) de planes, con su calificación propia (intención, paradas o pedido de ubicación, enlaces del portal, sin filtrar instrucciones). La demo de muestra suma horarios a sus destinos.

## Consecuencias

- (+) El criterio del paso no depende del modelo: el motor lo garantiza y las pruebas lo verifican con datos aleatorios y con el evento terminado del seed.
- (+) Un plan cuesta una sola llamada corta al modelo (sin búsqueda ni pasajes), y ninguna cuando falta la ubicación o no hay nada que recomendar.
- (+) El horario sirve también fuera del asistente: «Abierto ahora» en la ficha y respuestas a «¿a qué hora abre…?».
- (−) **Privacidad:** varias distancias redondeadas permiten estimar dónde está el visitante con un margen de unos cien metros. No se guardan, no llegan al proveedor de IA y la página de privacidad lo explica.
- (−) Distancias y tiempos en línea recta: no siguen calles ni pendientes. La página lo dice; «Cómo llegar» abre la app de mapas.
- (−) Sin horarios por fecha (feriados, temporadas) ni rangos que pasen la medianoche: la nota del horario lo cubre por ahora.
- (−) Las demos creadas antes de este paso no tienen horarios hasta que se editen sus destinos (la carga de muestra no reemplaza lo existente).
