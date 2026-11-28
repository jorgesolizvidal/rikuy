# ADR-074 — Métricas por canal y preguntas frecuentes

- **Estado:** Aceptada — 2026-11-27
- **Concreta:** A · Paso 5 (métricas por canal y preguntas frecuentes)
- **Se apoya en:** [ADR-036](ADR-036-ai-gateway.md) (gateway de IA y huella del visitante), [ADR-052](ADR-052-statistics-panel.md) («Estadísticas»), [ADR-053](ADR-053-unanswered-questions.md) (lo que preguntan los visitantes), [ADR-054](ADR-054-copilot-recommendations.md) (recomendaciones), [ADR-055](ADR-055-monthly-report.md) (informe mensual), [ADR-071](ADR-071-assistant-only.md) (canales del asistente) y [ADR-073](ADR-073-person-handoff.md) (pasar a una persona)

## Contexto

El asistente ya llega por tres caminos: el portal, la web del municipio (ADR-071) y los QR «Pregúntale a…». Llegará un cuarto, WhatsApp (A · Paso 6). El municipio no sabe cuál le trae visitantes, de qué preguntan más ni qué hacen con la respuesta. Tampoco tiene páginas de preguntas frecuentes, que son lo que leen Google y los buscadores con IA.

Decisiones del usuario (2026-11-27):

- **dos PR con un solo ADR:** 5.1 métricas por canal, 5.2 preguntas frecuentes;
- **«qué hizo después» es solo lo que toca desde el asistente:** las fuentes y tarjetas, la ruta en el mapa, el tour, una sección del portal y «Hablar con una persona». Sin seguir al visitante por las páginas que abre después;
- **los temas más preguntados salen de lo que citó cada respuesta**, sin IA: «Museo: 14 preguntas». Las preguntas sin respuesta siguen agrupadas por sus palabras (ADR-053);
- **las preguntas frecuentes las escribe el equipo, con ayuda del Copilot:** un tipo de contenido del panel; el Copilot puede proponer un borrador a partir de las preguntas más hechas, citando lo publicado. Nada se publica solo, y el asistente las usa como conocimiento.

## Decisión

### 1. Cada conversación con su canal (5.1)

1. **`assistant_turns`**, una fila por respuesta del asistente del visitante, ligada a su pedido del gateway (`ai_requests`, se borra con él a los 90 días): día del municipio, **canal** (`portal`, `embed`, `qr`, `whatsapp`), **tipo** (respondida, sin respuesta, plan o aviso) y tipo de página. Sin texto ni nada del visitante.
2. El canal sale del mismo parámetro que ya decide los enlaces (`?canal=insertar|qr`, ADR-071); sin él, portal. `whatsapp` queda reservado para el Paso 6.
3. **`ai_api.record_assistant_turn`** (solo `rikuy_ai`) la guarda después de responder (`after()`): un pedido del asistente de este municipio de los últimos 15 minutos, una vez.
4. «Quiero hablar con una persona» escrito no es una respuesta del modelo (ADR-073): no cuenta como conversación.

### 2. Los temas, por lo que citó la respuesta

1. **`assistant_turn_citations`**: cada respuesta guarda los contenidos que citó (destino, evento, servicio, relato, aviso o conocimiento; un tour cuenta para su lugar), hasta 12, resueltos por la base desde su tipo y dirección en este municipio.
2. «Los temas más preguntados» es cuántas respuestas citaron cada contenido en el período, el más citado primero.

### 3. Lo que tocó después

1. **`assistant_turn_actions`**: al tocar un enlace dentro de una respuesta, el navegador avisa a `POST /asistente/accion` con la referencia de la respuesta (ADR-073) y la dirección del portal a la que lleva. El servidor la clasifica: **lugar** (una ficha, un servicio, un relato, un aviso), **tour**, **mapa**, **sección** del portal o **persona** (WhatsApp, «Llamar» o el correo de «Hablar con una persona»).
2. **`ai_api.record_assistant_action`** la guarda si la respuesta se registró, es de la última hora y del **mismo visitante** (la huella diaria de ADR-036), una vez por respuesta, acción y contenido, y hasta 20 por respuesta.
3. Nada de lo que el visitante hace después en otras páginas se une a la conversación.

### 4. Dónde se ve

1. **«Estadísticas»** suma «El asistente por canal»: por canal, conversaciones, personas (distintas por día, sumadas, como las visitas), sin respuesta, pidieron una persona y toques después; los temas más preguntados; y qué tocaron.
2. **El informe mensual** (página y correo) suma lo mismo del mes.
3. **Las recomendaciones del Copilot** leen esos hechos (fuente «preguntas de los visitantes», sin un tipo de fuente nuevo).
4. Todo lo lee `private.assistant_statistics`, para cualquier miembro (`tenant_assistant_statistics`) y para el ejecutor del informe.

### 5. Preguntas frecuentes (5.2)

Un tipo de contenido `faq` (pregunta y respuesta con el formato de los destinos), con el flujo de revisiones de siempre; una página pública con datos estructurados `FAQPage`; el asistente las lee como conocimiento; y «Proponer con el Copilot» desde «Lo que preguntan los visitantes».

Decisiones del usuario (2026-11-27):

- **página propia y en la ficha:** `/preguntas-frecuentes` con todas, agrupadas por tema, y las de un lugar también en su ficha;
- **se publican como los destinos:** los editores preparan borradores; propietarios y administradores publican y retiran;
- **el Copilot propone un borrador solo con lo publicado:** desde «Lo que preguntan los visitantes» propone la pregunta y una respuesta sacada solo de lo publicado, con sus fuentes. Si nada publicado la responde, propone solo la pregunta y el equipo escribe la respuesta;
- **sin módulo, como los avisos:** todo municipio las tiene. Sin portal, el asistente igual las usa.

Detalles fijados al implementarlo:

- **la pregunta** es el título (hasta 120 caracteres) y **la respuesta** el resumen (una línea de hasta 300, obligatoria para publicar): es lo que leen primero los visitantes y lo que va en `FAQPage`. **«Más detalles»** es opcional, con el formato de los destinos;
- **el tema** es de una lista fija de la plataforma: Cómo llegar, Horarios y precios, Servicios, Historia y cultura, La visita y Otras preguntas. La página los muestra en ese orden; un tema sin preguntas no aparece;
- **el lugar** es opcional: un destino o un evento del mismo municipio. Se muestra solo si está publicado;
- **todas las respuestas están en la página**, sin desplegables: los buscadores solo toman lo que el visitante puede leer. Cada pregunta tiene su ancla, y las citas del asistente llevan a ella (`/preguntas-frecuentes#…`). La página se indexa y está en el sitemap;
- **el asistente** las indexa como cualquier contenido publicado, con «Pregunta frecuente del municipio (tema).» y su lugar. Las métricas por canal (5.1) las cuentan como un tema más;
- **el Copilot** busca en lo publicado como el miembro (4 pasajes). Sin pasajes, propone solo la pregunta **sin llamar al modelo** (no gasta cuota). Con pasajes, pide `PREGUNTA`, `RESPUESTA`, `TEMA` y `FUENTES`; una respuesta sin una fuente que exista, o con «NO_SE», se descarta. Los enlaces se quitan de la respuesta. Nada se guarda hasta «Crear el borrador», y entonces solo como borrador; solo editores o más, con el módulo del Copilot y la IA configurada. Sin el Copilot, el enlace abre «Nueva pregunta» con la pregunta escrita;
- **no tienen «Página en la web del municipio»** (ADR-071): en un municipio sin portal, la cita del asistente se muestra sin enlace.

## Consecuencias

- **Gana:** el municipio ve qué canal le trae conversaciones, de qué preguntan y si la respuesta sirvió para algo, sin guardar nada del visitante.
- **Costo:** tres tablas, tres funciones, una ruta y un aviso más desde el navegador; nada se agrega a la página al abrirse (el panel del asistente se descarga al abrirlo).
- **Preguntas frecuentes:** el municipio responde una vez lo que más preguntan, y la respuesta llega a la página, a la ficha, a los buscadores y al asistente. Una migración con un tipo nuevo, dos columnas y una lectura anónima.
- **Límites:** solo se cuenta desde que se despliega; la huella cambia si el teléfono cambia de red (como en ADR-073); un enlace abierto con el botón del medio o copiado no siempre avisa; se cuentan respuestas, no personas que leyeron la respuesta.
