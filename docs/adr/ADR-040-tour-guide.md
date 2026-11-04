# ADR-040 — Guía dentro del tour 360°: escena y punto resueltos en el servidor, en la misma conversación

- **Estado:** Aceptada — 2026-11-03
- **Concreta:** ADR-022 y ADR-038 para el roadmap P5 · Paso 5 (contrato RC-05)

## Contexto

En el sistema anterior, el guía virtual del tour era una conversación aparte («¿Qué estoy viendo?»). Recuperaba el panorama, sus puntos y la entidad padre, pero **aceptaba como contexto los datos que mandaba el navegador** y buscaba el punto por su título (auditoría 01). En producción respondía con errores genéricos (auditoría 06).

El contrato RC-05 de la auditoría pide:

- probar preguntas sobre un punto con contexto conocido, sin contexto y con contexto malicioso;
- usar la versión, el idioma y el municipio correctos;
- citar, y abstenerse si falta información;
- **no atribuir visión del objeto al texto editorial:** el asistente no ve la imagen.

Rikuy ya tiene un solo asistente con una conversación (ADR-038), fragmentos indexados de los tours publicados con su escena y su punto (ADR-037), y el visor público del tour (ADR-031).

Decisiones del usuario (2026-11-03):

- **Botón y puntos:** «¿Qué estoy viendo?» en la barra del tour y «Preguntar … sobre esto» en los diálogos de los puntos. Las preguntas escritas también saben en qué escena está el visitante.
- **Escena, puntos y lugar:** la guía responde con el texto de la escena, de sus puntos y de lo publicado del destino o evento. Si no hay texto, lo dice y no inventa.
- **Encima de la pantalla completa:** la conversación aparece sobre el tour sin salir de pantalla completa.

## Decisión

1. **El navegador solo nombra IDs.** El tour mantiene un contexto compartido con el panel del asistente (`lib/assistant-context.ts`): la página del tour (`destination_tour` o `event_tour` y su dirección), la escena en pantalla y el punto abierto.
   - La pregunta lleva `tour: { sceneId, hotspotId }`. El servidor acepta solo UUID, y solo en la página de un tour.
   - Ningún texto sobre la escena llega desde el navegador.
   - En `/recorrido`, al saltar de tour, el contexto sigue al tour actual.
2. **El servidor resuelve el contexto** con `ai_api.tour_context` (solo el rol `rikuy_ai`), contra el **tour publicado ahora** de ese destino o evento, en un municipio en línea:
   - la escena pedida, solo si ese tour publicado la tiene; si no, la de entrada, marcada `unknown`. Un borrador, otra revisión, otro tour u otro municipio nunca se usan;
   - el punto, solo si es de esa escena;
   - los pasajes, con la misma forma que la búsqueda (y por lo tanto con su cita D5): primero el texto del punto, después el de la escena, otro punto de la escena y las primeras secciones del destino o evento. Son hasta 3 del tour y 2 del lugar.
3. **Una sola conversación** (ADR-038), con modo guía cuando el contexto se resolvió:
   - «¿Qué estoy viendo?» y «Preguntar … sobre esto» envían `intent: "guide"`. Basta con **una llamada** al modelo con los pasajes de la escena, sin reformular ni buscar;
   - una pregunta escrita dentro del tour reformula y busca como siempre, y suma los pasajes de la escena primero (hasta 5 en total);
   - el modelo recibe una regla fija más: «No puedes ver la imagen: cuenta solo lo que dicen las fuentes; nunca digas que ves algo; si las fuentes no describen la escena o el punto, dilo». Los nombres de la escena y del punto van en el mensaje del visitante, como datos;
   - las citas se validan igual que siempre; un pasaje del tour enlaza a su escena (`?escena=`).
4. **Encima de todo:** si el tour está en pantalla completa o hay un diálogo de punto abierto, el panel se abre con `showModal()`. Así entra en la capa superior, sobre la pantalla completa y sobre el diálogo, y se puede usar. Al cerrarlo, el foco vuelve al botón que preguntó. En las páginas de tour, el botón flotante se oculta: el de la barra lo reemplaza y no tapa los controles en el celular.
5. **Gold:** 5 casos nuevos sobre el tour de muestra de las demos (G47–G51):
   - «¿Qué estoy viendo?» en español y en inglés;
   - una pregunta escrita;
   - una escena inexistente (contexto ausente);
   - un pedido de describir colores y personas «que ves» (malicioso).

   Se califican por la cita (tour o lugar), por reconocer el tour y por **no decir que ve la imagen**. El tour de muestra suma descripciones a sus dos escenas.

## Consecuencias

- (+) Se cumple RC-05: el contexto conocido se usa, el ausente cae en la escena de entrada sin inventar, y el malicioso (otro tour, IDs falsos, texto en lugar de IDs) nunca llega al modelo como contexto.
- (+) «¿Qué estoy viendo?» cuesta una sola llamada corta.
- (+) El visitante sigue en la misma conversación al entrar y salir de un tour.
- (−) La guía no ve la imagen: si el municipio no escribió la escena ni sus puntos, solo puede decir eso y hablar del lugar. El panel del municipio ya lo invita a escribir las descripciones.
- (−) Una escena sin texto ni puntos con texto no tiene fragmentos. La guía depende de lo que el municipio publicó.
- (−) Las demos creadas antes de este paso conservan su tour de muestra sin descripciones de escena.
