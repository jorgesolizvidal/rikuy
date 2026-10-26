# ADR-029 — Puntos de los tours: cuatro tipos, cambios parciales e «ir a otro recorrido» resuelto al abrirlo

- **Estado:** Aceptada — 2026-10-26 («ir a otro recorrido» con acabado propio: decisión del usuario)
- **Concreta:** tabla 10 del esquema piloto (`hotspots`) y el contrato RC-01

## Contexto

En el sistema anterior, editar un hotspot de modelo sin que su selector cargara a tiempo podía guardar un formulario vacío y perder relaciones (RC-01). El HTML de los hotspots se interpolaba sin escapar (SEC-06). Y el usuario pidió poder pasar de un recorrido a otro desde dentro del 360°, con un punto que se vea terminado, no como una flecha más.

## Decisión

1. **Cuatro tipos**, cada uno con exactamente su destino. La base lo comprueba: los campos de otros tipos quedan vacíos.
   - **información**: título, texto enriquecido (el mismo AST permitido de los destinos, ≤ 20 KB) y hasta 12 fotos con descripción obligatoria;
   - **ir a otra escena**: otra escena de la **misma revisión** del tour;
   - **modelo 3D**: un GLB listo del mismo municipio;
   - **ir a otro recorrido**: un destino o evento del mismo municipio, nunca el propio.
2. **Posición en yaw/pitch (radianes)**, como el visor e independiente de cómo se entregue la imagen. El panel normaliza y redondea sin salirse de los límites.
3. **Ediciones por intención** con el número de edición del borrador: agregar, cambiar y quitar.
   - «Cambiar» recibe solo los campos que el formulario tocó (RC-01): guardar el título nunca reescribe el texto, las fotos, la posición ni el destino.
   - **El tipo no cambia**: para cambiarlo se quita el punto y se agrega otro.
   - Todo lo elegido debe ser del mismo municipio, así que una selección de otro municipio nunca se guarda.
4. **`hotspot_id` estable entre revisiones**: un borrador nuevo copia los puntos y sus fotos con el mismo identificador. Volver a una versión devuelve sus puntos.
5. **Quitar una escena quita sus puntos y las flechas que llevaban a ella** (FK compuestas con borrado en cascada). El panel lo avisa en la confirmación.
6. **«Ir a otro recorrido» apunta al contenido, no a una revisión.**
   - El portal lo resolverá a la escena de entrada del tour publicado del destino cuando el visitante lo abra.
   - Mientras ese destino no tenga tour publicado, el punto no se muestra. No impide publicar.
   - Se ve como una **píldora con ícono de lugar y «Ir a · {destino}»**, en otro color, distinta de las flechas.
7. **Publicar exige** las fotos listas y que cada modelo 3D tenga su poster (ADR-026): es lo que el visitante ve mientras carga.
8. **El aspecto de los puntos es código compartido** (`hotspot-markers.ts`) para el panel y el portal. Se arma con nodos del DOM y `textContent`: el texto del municipio nunca se vuelve HTML (SEC-06). Se colocan con el plugin de marcadores de Photo Sphere Viewer 5.15.1.

## Consecuencias

- (+) RC-01 queda garantizado en la base y probado con la Data API.
- (+) Agregar un punto no exige puntero: «Poner en el centro de la vista» lo coloca donde mira el visor, que se mueve con el teclado.
- (−) Cambiar el tipo de un punto obliga a recrearlo (con otro identificador).
- (−) Un «ir a otro recorrido» cuyo destino nunca publica su tour queda guardado pero invisible. El panel lo muestra atenuado y avisa.
