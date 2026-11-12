# Contratos de los tours (RC-01, RC-02, RC-05, RC-07, RC-08)

Registro de los contratos de regresión de P4 según la auditoría `14-regression-contracts-evals` (§1, reglas de evidencia). Cada contrato dice de dónde viene, con qué datos se prueba, dónde corre, qué se comprobó y qué queda fuera.

**Entorno de CI** (job «Browser · Tours (RC-01/07/08) · Lighthouse of the tours · evaluation»; antes, «Contracts (RC-09/10/11/12) · Lighthouse budget»): GitHub Actions `ubuntu-latest`, compilación de producción (`next start`), Supabase local con el seed, Chrome del runner con WebGL por software (SwiftShader). Los municipios son los del seed (Demo Norte, Demo Sur); los tours de prueba se crean en **Demo Sur** con las mismas RPC que el panel, como su propietario (`owner@demo-sur.example.test`).

**Datos de prueba (fixtures):** sintéticos y generados en cada corrida, ninguno en el repositorio:

- 4 panoramas de colores distintos (2048 px, y uno de 8192 px servido como teselas), procesados con el mismo renderizador que producción;
- 2 fotos;
- 1 modelo GLB: un modelo sintético con colores por vértice, texturas y mapa de normales, pasado por el procesador y el optimizador reales (Meshopt y KTX2), con su poster;
- los tours de referencia: **Museo de prueba** (3 escenas: entrada, sala grande en teselas y taller; con información y galería, flechas, modelo 3D e «ir a otro recorrido»), **Carnaval de prueba** (4 escenas en fila, con flechas hacia adelante y hacia atrás, información y galería en la entrada) y **Plaza de prueba** (1 escena, destino de «ir a otro recorrido» y tour de inicio del recorrido general).

Los archivos reales del usuario (panoramas DJI, `horno.glb`, `monumento.glb`, la ametralladora) no entran al repositorio: se usan en las verificaciones manuales de cada paso, anotadas en el [checkpoint](progress/CHECKPOINT.md).

## RC-01 — editar un punto no borra sus relaciones

- **Fuente:** en el sistema anterior, el punto del modelo del museo se listaba con su panorama, pero el formulario de edición no tenía la opción resuelta y no se podía guardar.
- **Contrato:** guardar solo el nombre y recargar conserva la escena, el tour, el tipo, el destino o modelo, la galería y la posición; lo que no se envía no se borra; cambiar de un punto A a otro B nunca conserva la selección de A.
- **Dónde se prueba:**
  - base de datos (`019_hotspots`, `022_model_descriptions`): `update_tour_hotspot` cambia solo los campos enviados; el tipo no cambia; cambiar el nombre conserva escena, tipo, posición, texto y fotos; mover conserva el modelo; cambiar el modelo conserva la descripción;
  - Data API (`tours.int.test.ts`): el mismo cambio parcial contra Supabase real;
  - **panel en un navegador** (`apps/web/e2e/tour.e2e.test.ts`, «RC-01: the panel's point editor…»):
    1. el propietario entra con su código y abre el editor del museo;
    2. el modelo y su descripción aparecen elegidos en el formulario;
    3. cambia solo el nombre, guarda y recarga: siguen elegidos;
    4. en la base, el punto del borrador es igual al publicado salvo el nombre (escena, tipo, modelo, descripción, yaw y pitch);
    5. lo mismo con el punto de información: su texto y sus dos fotos, en su orden;
    6. abre «Ir a la plaza», cambia su destino sin guardar y abre «A la sala»: este muestra su propia escena; al volver, «Ir a la plaza» muestra su destino guardado y el modelo sigue siendo el suyo; nada de eso se guardó;
    7. descarta el borrador: el tour publicado nunca cambió.
- **Limitación:** la auditoría pide cargar las opciones antes y después del objeto. En Rikuy, las opciones (escenas, modelos, destinos) y el punto llegan en la misma respuesta del servidor, así que esa carrera no puede ocurrir; la prueba cubre la recarga.

## RC-02 — una sola escena de entrada y el grafo al volver a una versión

- **Fuente:** 24 panoramas con «Inicial» en el panel del sistema anterior.
- **Contrato:** tour con dos escenas y luego cuatro; publicar sin entrada falla; una entrada de otro tour o municipio falla; cambiar la entrada deja exactamente una referencia; reordenar no cambia la entrada; volver a una versión conserva el grafo.
- **Dónde se prueba:**
  - base de datos (`018_tours`): la entrada es una columna de la revisión con FK compuesta a una escena de la misma revisión (una sola referencia por construcción); sellar sin entrada falla; entrada de otro tour, rechazada; reordenar no la cambia; quitar la entrada pasa a la primera escena; volver a la versión 1 restaura escenas, orden y entrada; `019_hotspots` y `020_tour_publication`: volver a la versión 1 restaura sus puntos y su propio manifiesto;
  - Supabase real (`tours.int.test.ts`): dos escenas → cuatro → volver a dos con su entrada, en Demo Sur; el analista solo lee y el propietario de otro municipio no ve nada.
- **Limitación:** es un contrato de datos y se prueba en la base y la API, no en el navegador (el botón «Usar como entrada» del panel se verificó a mano en P4 · Paso 1).

## RC-05 — la guía dentro del tour

- **Fuente:** en el sistema anterior, la guía del tour aceptaba como contexto los datos que mandaba el navegador y buscaba el punto por su título; en producción respondía con errores genéricos (auditorías 01 y 06).
- **Contrato:** pregunta sobre un punto con contexto conocido, sin contexto y con contexto malicioso; versión, idioma y municipio correctos; citar y abstenerse si falta; no atribuir visión del objeto al texto editorial ([ADR-040](adr/ADR-040-tour-guide.md)).
- **Dónde se prueba:**
  - base de datos (`029_tour_guide`): la escena y el punto pedidos se resuelven contra el tour publicado; sin escena, la de entrada; una escena de borrador, un punto de otra escena o una escena de otro municipio con la misma dirección se ignoran; solo el rol `rikuy_ai`, solo municipios en línea; un texto publicado con instrucciones vuelve como pasaje, nunca como reglas;
  - `@rikuy/core` (`ask.test.ts`): la regla de la guía es código (el nombre de la escena y su texto van en el mensaje del visitante); «¿Qué estoy viendo?» hace una sola llamada sin búsqueda; el navegador no puede mandar texto ni IDs que no sean UUID, ni fuera de un tour;
  - integración (`demo.int.test.ts`): los casos G47–G51 del gold con el tour de muestra real y la búsqueda real;
  - **navegador** (`apps/web/e2e/tour.e2e.test.ts`, «RC-05: the guide knows the scene and the point…»):
    1. «¿Qué estoy viendo?» envía la escena en pantalla como ID y la respuesta cita el tour, con enlace a él y nunca al carnaval;
    2. «Preguntar … sobre esto» en el punto «Arados antiguos» envía su ID, se abre encima del diálogo y la respuesta habla de ese punto; Escape cierra solo el asistente;
    3. en pantalla completa, la conversación aparece encima sin salir de ella;
    4. una escena de otro tour, un ID inventado y texto en lugar de un ID responden igual desde la escena de entrada de **este** tour, sin nada del otro.
- **Limitaciones:** en el CI el modelo es el simulado: comprueba qué llega al modelo y qué se cita, no la redacción. La redacción y «no decir que ve» se miden con el modelo real en «Evaluar el asistente» (G47–G51).

## RC-07 — recorrer los tours de referencia

- **Fuente:** museo de dos escenas y carnaval de cuatro; en el sistema anterior se observaron el dibujo y la navegación, pero no todas las interacciones del carnaval.
- **Contrato:** recorrido completo de las dos fixtures (entrada → información → galería → siguiente → anterior → salida); los cambios rápidos y las respuestas tardías no devuelven una escena vieja; la lista en texto funciona sin WebGL.
- **Dónde se prueba** (`apps/web/e2e/tour.e2e.test.ts`):
  - «RC-07: walks each reference tour…»: en el museo y en el carnaval, información y galería desde la lista, luego «Siguiente» hasta la última escena y «Anterior» hasta la entrada. En cada paso se comprueba por el color en pantalla que se ve la escena correcta, con su número («Escena n de N») y su nombre. Al final, «Volver a…» lleva al destino;
  - «walks the whole tour…»: en el museo, cada tipo de punto desde el panorama (información, flecha, modelo, «ir a otro recorrido»), la escena grande servida con teselas y sin su imagen completa, y la ficha sin ningún archivo del panorama;
  - «ends on the last scene asked for…»: con una escena respondiendo 2,5 s tarde, pedirla y enseguida otra termina en la segunda; cuatro toques seguidos terminan en el último;
  - «is one general tour…»: saltos entre tours sin salir del visor, «atrás», y una respuesta tardía de otro tour que no gana;
  - «works as text without WebGL…»: Chrome sin WebGL, con el teclado, a 390 px.
- **Limitación:** el museo de referencia tiene tres escenas (la auditoría dice dos): la tercera es la grande, para cubrir las teselas.

## RC-08 — el modelo 3D solo al abrirlo

- **Fuente:** la ametralladora del museo se dibujaba en el sistema anterior.
- **Contrato:** con el GLB autorizado o un sustituto con el mismo contrato: abrir, cerrar y volver a abrir; error y reintento; foco y alternativa en texto; cero peticiones del GLB antes de abrir el punto; liberar recursos; ninguna dirección externa inesperada.
- **Dónde se prueba** (`apps/web/e2e/tour.e2e.test.ts`, «RC-08: the model loads only when asked for…» y el caso sin WebGL), con el sustituto: un GLB sintético pasado por el optimizador real, con texturas KTX2.
  - Ninguna petición del GLB ni del visor 3D antes de pulsar «Ver en 3D», con el diálogo ya abierto.
  - Una descarga al abrir; el modelo en lugar del poster; el foco en el modelo.
  - Con «reducir movimiento», nada se mueve solo; las flechas lo giran e Inicio vuelve a la primera vista.
  - «Volver a la imagen» quita el canvas y deja el contexto WebGL liberado; el foco vuelve al botón.
  - Volver a abrir; cerrar el diálogo y reabrir el punto empieza en el poster.
  - Una descarga que falla deja el poster y «Reintentar», que funciona.
  - Un contexto WebGL perdido vuelve al poster con aviso y se puede volver a abrir.
  - Solo se piden archivos al portal y a Storage; el transcodificador KTX2 sale del portal.
  - Sin WebGL: poster, descripción, aviso y el foco en el aviso.
- **Limitación:** el GLB real de la ametralladora no se usa en CI (no entra al repositorio y tiene problemas propios de color, anotados para Blender). Los modelos reales del usuario se verificaron a mano en P4 · Paso 6.

## Lighthouse de las páginas de tour

`e2e/lighthouse.mjs` con `LIGHTHOUSE_SET=tours` mide el primer tour del sitemap de cada portal y el recorrido general (`/recorrido`): en el PR, después de RC-07, sobre los tours de prueba de Demo Sur; en producción, sobre los tours que tengan publicados los portales de demo (si no hay, deja un aviso). Los umbrales están en `apps/web/lighthouse-budget.json` (`tour`, `generalTour`; el LCP en 3 s desde la medición final, ver abajo); ver el [presupuesto de rendimiento](performance-budget.md).

## Medición en el dispositivo (`?medir`)

Agregar `?medir` a la dirección de un tour abre un panel de medición, cargado solo en ese caso. Mide en el propio dispositivo y no envía nada:

- **dispositivo:** modelo, sistema y navegador (cuando el navegador lo informa), memoria aproximada, núcleos, GPU, pantalla y red;
- **carga:** primer byte, primer contenido, LCP, página cargada, arranque del visor y primera escena en pantalla;
- **datos descargados:** archivos y tamaño por tipo. Storage, en otro dominio, no deja ver los tamaños;
- **20 cambios de escena:** mediana, p95 y el más lento, cambios sin terminar y memoria JS antes y después;
- **fluidez:** cuadros por segundo y cuadros largos mientras se gira el panorama 5 s;
- **modelo 3D:** tiempo desde «Ver en 3D» hasta verlo, su tamaño y la memoria JS.

«Copiar resultados» deja todo como texto. Lo que el navegador no ofrece (la memoria JS fuera de Chrome, el modelo del teléfono) sale como «no disponible», nunca estimado.

## Resultados

| Contrato | Estado                                                    | Dónde                          | Primera corrida en verde                                       |
| -------- | --------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| RC-01    | `RUNTIME_CONFIRMED` en CI (laboratorio)                   | pgTAP, integración y navegador | commit `6c4e523`, CI de la rama `feat/p4-step7-tour-contracts` |
| RC-02    | `RUNTIME_CONFIRMED` en CI (base de datos y API)           | pgTAP e integración            | desde P4 · Paso 1                                              |
| RC-07    | `RUNTIME_CONFIRMED` en CI (laboratorio)                   | navegador                      | commit `6c4e523`                                               |
| RC-08    | `RUNTIME_CONFIRMED` en CI (laboratorio), con el sustituto | navegador                      | desde P4 · Paso 6; reabierto y ampliado en el Paso 7           |

Lighthouse del tour en el CI (móvil, mediana de 3), en el tour de una escena y en `/recorrido`: rendimiento 79 y 88 en las dos primeras corridas (el runner varía), LCP 2,4 s y TBT 0,4–0,76 s.

**En Android:** el usuario probó los tours en su celular, en producción, tras los Pasos 4, 5 y 6: funcionan bien.

### Medición final en el dispositivo (2026-10-27)

Con `?medir` en producción, en el tour de `mirador-del-valle` (Demo Norte), una corrida por equipo. Los objetivos son los que propone la auditoría (§4).

| Métrica                                            | Android                                                               | PC                                                 | Objetivo de la auditoría                                     | Resultado                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Equipo                                             | CRT-NX3, Android 15, Mali-G57 MC2, ≥ 8 GB, 8 núcleos, 360 × 796 px ×3 | Windows, AMD Radeon (integrada), 16 GB, 16 núcleos | Android de gama media identificado por modelo, sistema y GPU | identificado                                                         |
| Red (informada por el navegador)                   | 4G, ~3,3 Mbps, ~150 ms                                                | ~8,6 Mbps, ~200 ms                                 | rápida 20 Mbps / 40 ms y lenta 1,5 Mbps / 150 ms             | entre los dos perfiles; no es una red controlada                     |
| Primer contenido / LCP                             | 0,68 s / 0,68 s                                                       | 0,94 s / 0,99 s                                    | —                                                            | bien                                                                 |
| Primera escena en pantalla                         | 1,46 s                                                                | 2,17 s                                             | vista previa ≤ 2 s (red lenta); utilizable ≤ 2,5 s (rápida)  | cumple                                                               |
| 20 cambios de escena: mediana / p95 / el más lento | 0,93 / 0,95 / 0,96 s                                                  | 0,80 / 0,85 / 0,87 s                               | p95 ≤ 2 s; ninguno sin terminar                              | cumple (0 sin terminar)                                              |
| Fluidez al girar 5 s                               | 87 cuadros/s (pantalla de 120 Hz), p95 16 ms, 0 de más de 50 ms       | 60 cuadros/s, p95 17 ms, 0 de más de 50 ms         | ≥ 30 cuadros/s sostenidos                                    | cumple (cuadros del navegador, no medición de GPU)                   |
| Modelo 3D hasta verlo                              | 3,6 s                                                                 | 1,2 s                                              | sin GLB antes de abrirlo; sin pérdida de contexto            | listo, sin pérdida de contexto                                       |
| JavaScript transferido                             | 431 KB                                                                | 430 KB                                             | —                                                            | incluye three.js, el visor 360° y el visor 3D                        |
| Memoria JS en 20 cambios                           | 15,4 → 15,4 MB                                                        | 139 → 176 MB (+27 %)                               | crecimiento tras calentamiento ≤ 20 %                        | **no concluyente en el dispositivo**; en laboratorio, cumple (abajo) |

**Lighthouse en producción** (simulado, móvil, mediana de 3, dos corridas tras el merge del Paso 7):

- el tour del mirador: rendimiento 85 y 81, LCP 2,9 y 2,57 s;
- `/recorrido`: rendimiento 87 y 79, LCP 2,09 y 2,88 s.

Pasaban el umbral de LCP de 2,5 s fijado con el CI, donde Storage está en la misma máquina. En el celular real el LCP es 0,68 s, así que el umbral de laboratorio del tour pasa a 3 s. El de las demás páginas sigue en 2,5 s.

**Sobre la memoria:**

- Chrome para Android redondea `performance.memory` y lo actualiza muy de vez en cuando, por eso sale igual antes y después: no mide nada.
- En la PC se leyó sin recolección de basura, justo después de los cambios. La cifra de partida (138 MB) incluye lo que cargan las extensiones del navegador en la misma página.
- Para separar una fuga real del ruido, se repitió en laboratorio con memoria precisa y recolección forzada antes de cada lectura (Chromium con SwiftShader, tours de prueba del CI, 80 cambios):

| Tour                              | Al empezar | Tras 20 (calentamiento) | Tras 40 | Tras 60 | Tras 80 | Nodos y listeners    |
| --------------------------------- | ---------- | ----------------------- | ------- | ------- | ------- | -------------------- |
| Carnaval (4 escenas)              | 7,5 MB     | 9,3 MB                  | 9,5 MB  | 9,7 MB  | 9,8 MB  | estables (397 / 478) |
| Museo (3 escenas, una en teselas) | 7,6 MB     | 9,4 MB                  | 9,6 MB  | 9,8 MB  | 9,9 MB  | estables (423 / 481) |

Después del calentamiento, 60 cambios más suman un 5 %, sin crecer los nodos ni los listeners: no hay fuga, y está dentro del 20 %.

**Límites de esta medición:**

- una sola corrida por equipo, no las 20 en frío y 20 en caliente del protocolo de la auditoría;
- red real, no controlada;
- el tamaño de los panoramas y del GLB no se ve, porque Storage está en otro dominio y no envía `Timing-Allow-Origin`;
- la memoria de la GPU no se puede medir desde la página.

### Teselas en el dispositivo (2026-11-10, gate P6 · criterio 5)

Hasta aquí ningún panorama de producción pasaba de 4096 px (los de Demo Norte son de 2880), así que la entrega en teselas ([ADR-020](adr/ADR-020-panorama-delivery-by-resolution.md)) solo se había probado en el CI y en local. El usuario subió a Demo Norte `DJI_0876.JPG`, un panorama real de 8192 × 4096 px (11,6 MB): quedó con **168 teselas en 3 niveles** y una imagen de respaldo de 4096 px. Lo publicó como única escena del tour de «Concierto de la banda» y lo midió con `?medir=1` en su celular (CRT-NX3, Android 15, Mali-G57 MC2), una corrida por combinación:

| Métrica                    | Chrome · wifi                      | Chrome · datos móviles             | Firefox · datos móviles            | Objetivo de la auditoría                                    |
| -------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| Red (informada)            | ~6,8 Mbps, ~250 ms                 | «3g», ~0,05 Mbps, ~550 ms          | no la informa                      | —                                                           |
| Primer byte / contenido    | 0,13 / 0,50 s                      | 1,03 / 1,32 s                      | 0,28 / 2,91 s                      | —                                                           |
| LCP                        | 0,50 s                             | 1,89 s                             | 3,81 s                             | —                                                           |
| Primera escena en pantalla | **1,11 s**                         | **1,86 s**                         | **5,24 s**                         | vista previa ≤ 2 s (red lenta); utilizable ≤ 2,5 s (rápida) |
| Archivos del panorama      | 31                                 | 39                                 | 42 (1,5 MB)                        | solo el nivel que la pantalla necesita                      |
| Fluidez al girar           | 84 cuadros/s, p95 17 ms, 0 > 50 ms | 58 cuadros/s, p95 45 ms, 6 > 50 ms | 63 cuadros/s, p95 24 ms, 0 > 50 ms | ≥ 30 cuadros/s sostenidos                                   |

- **Las teselas funcionan en el celular:** se descargaron entre 31 y 42 archivos (la vista previa y las teselas del nivel que pide la pantalla), no las 168, y el giro se mantuvo sobre 58 cuadros por segundo.
- **Chrome cumple** los dos objetivos: 1,11 s con wifi y 1,86 s con datos móviles lentos. Con datos, 6 cuadros pasaron de 50 ms al girar, mientras llegaban teselas nuevas por una red de ~0,05 Mbps.
- **Firefox con datos no cumple** el de red lenta: 5,24 s. No viene de las teselas: el primer texto de la página ya tardó 2,9 s y el visor espera a que la página termine de cargar (3,8 s). Con Chrome, en la misma red, la página cargó en 1,3 s.

**Límites:** una corrida por combinación, red real y no controlada; el tamaño de las teselas no se ve en Chrome (Storage no envía `Timing-Allow-Origin`); sin iPhone.
