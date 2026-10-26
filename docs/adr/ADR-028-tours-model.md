# ADR-028 — Tours 360°: uno por destino o evento, recorrido general derivado y escenas con identidad estable

- **Estado:** Aceptada — 2026-10-26 (estructura del tour y recorrido general: decisión del usuario)
- **Concreta:** tablas 7–9 del esquema piloto de la auditoría (`tours`, `tour_revisions`, `scenes`) y los contratos RC-01/RC-02

## Contexto

El sistema anterior marcaba la escena inicial con una bandera en cada panorama (en el panel llegó a haber 24 «Inicial») y sus formularios parciales podían borrar relaciones que no mostraban (RC-01). Además, el usuario quiere que el visitante recorra **todos** los tours del municipio sin salir del visor (P4 · Paso 5).

## Decisión

1. **Un tour como máximo por destino o evento**, y es opcional (decisión del usuario). Se crea desde «Tours 360°» y su nombre es el del contenido.
2. **El recorrido general no es un tour aparte**: se forma con los tours publicados de los contenidos publicados (decisión del usuario). Así nada se edita dos veces. El orden y el tour de inicio que elija el municipio llegan con el Paso 5.
3. **Revisiones como los destinos**: un borrador abierto, revisiones numeradas que se sellan al publicar (inmutables) y «volver a una versión» que mueve el puntero publicado. Volver a una versión devuelve el grafo entero (escenas, orden, entrada).
4. **Una sola escena de entrada**, como columna de la revisión (`entry_scene_id`). Una FK compuesta `(tenant_id, revisión, escena)` obliga a que sea una escena de la misma revisión. Un borrador puede no tenerla; sellar la exige. La primera escena que se agrega pasa a ser la entrada; si se quita la entrada, la toma la primera escena que queda.
5. **`scene_id` estable entre revisiones**: al abrir un borrador nuevo se copian las escenas con su mismo identificador, para que los hotspots (Paso 2) y los enlaces a una escena sobrevivan a las ediciones y a volver a una versión.
6. **Ediciones pequeñas por intención** (agregar, cambiar, mover, quitar, elegir entrada), cada una con el número de edición del borrador. «Cambiar» recibe solo los campos que el formulario envía; lo demás no se toca (RC-01).
7. **La publicación del tour es independiente de la del contenido**: el tour tiene su propio puntero publicado. El portal lo mostrará cuando **ambos** estén publicados. Así, publicar una corrección del tour no exige una revisión nueva del destino, y volver atrás el destino no deshace el tour.
8. **Ángulos en radianes, como el visor**: yaw en [-π, π), pitch en [-π/2, π/2] y campo de visión en grados (30–90), sin depender de cómo se entregue la imagen (ADR-020). El panel usa la imagen única ≤ 4096 px del panorama; el portal usará las teselas.
9. **Photo Sphere Viewer 5.15.1** para la vista 360°, sobre el mismo three.js 0.186.0 del visor de modelos (un _override_ de pnpm evita una segunda copia). Se carga bajo demanda, las flechas solo funcionan con el visor enfocado y sus controles se nombran como botones.

## Consecuencias

- (+) RC-02 queda garantizado por la base: nunca hay dos entradas, ni una entrada de otro tour o municipio, ni un tour publicado sin entrada.
- (+) Un formulario que guarda solo el título no puede perder la vista inicial ni el panorama.
- (−) El esquema piloto proponía publicar el tour a través de la revisión del contenido; aquí son dos punteros. A cambio, el portal tiene que comprobar los dos al mostrarlo (Paso 3).
- (−) Un panorama aparece una sola vez por tour. Repetir un lugar exige subirlo otra vez, cosa que en la práctica no hace falta.
