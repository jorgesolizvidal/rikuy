# ADR-048 — Reemplazar y borrar panoramas y modelos 3D; foto propia como poster

- **Estado:** Aceptada — 2026-11-10
- **Concreta:** los pendientes de P2 · Pasos 3 y 4 para el roadmap C0 · Paso 2

## Contexto

Hasta ahora, un panorama o un modelo 3D se sube una vez y queda para siempre. Si la foto 360° salió movida, o si un modelo se corrige en Blender, la única salida es subir otro y rehacer cada escena y cada punto que lo usaban. Tampoco se puede borrar lo que se subió por error: ocupa la cuota del municipio.

Además, el poster de un modelo (la imagen que se ve antes de abrirlo en 3D) solo puede ser una captura del visor del panel.

Condiciones:

- Los tours tienen revisiones selladas e inmutables, y «Volver a esta versión» tiene que seguir funcionando (ADR-028, ADR-030).
- Nada cambia para los visitantes hasta que alguien publica.
- Los arreglos en Blender de los modelos se suben al final del proyecto, con «Reemplazar».

Decisiones del usuario (2026-11-10):

- **Reemplazar:** la versión nueva entra en el borrador de cada tour que usa el medio; los visitantes la ven al publicar ese tour.
- **Borrar:** solo lo que ningún tour usa ni usó (borrador, versión publicada o una del historial). Si no se puede, el panel dice dónde se usa.
- **Poster:** se puede subir una foto propia o usar la captura del visor; vale la última que se elija.

## Decisión

1. **Un reemplazo es una versión nueva del mismo medio** (`asset_versions` versión N + 1), subida y procesada igual que la primera: URL firmada de un solo uso, el mismo pipeline, las mismas reglas y cuotas.
   - `create_media_replacement_upload` (propietarios, administradores y editores): solo panoramas y modelos, no borrados, del mismo tipo; uno a la vez por medio (`busy` si hay una versión subiendo o en proceso).
   - Las versiones anteriores no se tocan: las revisiones selladas que las usan siguen funcionando.

2. **«Usar la versión nueva en los tours»** (`apply_media_replacement`, propietarios, administradores y editores):
   - en cada tour cuya revisión de trabajo (su borrador o, si no tiene, la publicada) usa una versión anterior, pone la nueva en el borrador. Si no hay borrador, lo abre con los mismos identificadores de escenas y puntos;
   - las escenas conservan su vista inicial y sus puntos; los puntos de modelo, su posición y su texto;
   - el número de edición del borrador avanza, así un editor con la página vieja abierta debe recargar;
   - solo la versión lista más nueva; una más vieja se rechaza (`stale`);
   - se hace con un botón y no al terminar el procesamiento: así se revisa el resultado (y, en un modelo, su poster) antes de que llegue a los tours;
   - auditoría `media.replacement_applied`.

3. **Borrar** (`delete_media_asset`, solo propietarios y administradores):
   - solo si ninguna revisión de ningún tour usa alguna versión del medio (`in_use`) y ninguna se está procesando (`busy`);
   - en una transacción, marca el medio borrado (`assets.deleted_at`), rechaza cada versión (libera su cuota al instante) y encola un trabajo de limpieza por versión;
   - la limpieza reusa `media.remove_unused`: `claim_unused_media` también devuelve la carpeta de una versión de un medio borrado, y el ejecutor la borra de los dos buckets;
   - las listas del panel ya no lo muestran; nada puede volver a usarlo (una versión rechazada no está lista);
   - auditoría `media.deleted` con las versiones y los bytes.

4. **Dónde se usa** (`media_asset_uses`, cualquier miembro): por medio, cada tour con su destino o evento, si lo usa su borrador, su versión publicada o solo una versión anterior del historial, y si es su revisión de trabajo. El panel agrupa las versiones por medio con esto:
   - la versión actual (la lista más nueva) y un reemplazo en camino o rechazado;
   - «Lo usan: Tour de «…» · publicado, con la versión anterior»;
   - «Usar la versión nueva en los tours» cuando algún tour todavía usa una anterior;
   - «Borrar» solo cuando se puede; si no, el motivo.

5. **El editor del tour** ofrece solo la versión lista más nueva de cada medio, y nunca otra versión de uno que el tour ya usa.

6. **Foto propia como poster:** «Subir una foto como imagen» en «Modelos 3D». El navegador la reduce a 1.280 px (WebP o JPEG) para que entre en una acción del servidor, aplica su orientación y descarta sus metadatos (ubicación incluida). El servidor la vuelve a codificar como la captura y la base la registra con `set_model_poster`, sin cambios.

7. **Antes de la migración** (la web sale unos minutos antes): el panel no muestra usos, y reemplazar, usar la versión nueva y borrar fallan con un mensaje hasta que llega. La foto propia como poster funciona desde el principio.

## Consecuencias

- Los arreglos en Blender se suben con «Reemplazar» y llegan a los tours con un botón y una publicación, sin rehacer escenas ni puntos.
- Un medio que alguna vez se publicó en un tour no se puede borrar mientras exista esa versión en el historial. Es el precio de que «Volver a esta versión» funcione siempre. Si un tour se borra (Paso 3), sus medios pueden quedar libres.
- Un modelo nuevo necesita su poster antes de que el tour se publique (como al agregarlo por primera vez).
- Las versiones viejas de un medio reemplazado siguen ocupando cuota mientras las use el historial de algún tour.
- Un reemplazo con otra proporción o encuadre puede necesitar ajustar la vista inicial y la posición de los puntos: el panel no lo detecta.

## Corrección (2026-11-10, `fix/model-poster-republish`)

En producción, una foto propia como poster no llegaba al tour publicado, ni siquiera al publicarlo de nuevo:

- todos los posters de una versión se guardaban con el mismo nombre (`model/poster.webp`), y su copia pública tiene caché de un año;
- la publicación del tour no copiaba nada de un modelo que ya era público, así que la copia pública seguía siendo la vieja;
- un tour publicado sin borrador no se puede volver a publicar.

Desde la corrección:

- **cada poster tiene su propio nombre** (`poster-<8 hex>.webp`); `poster.webp` sigue valiendo para los anteriores;
- `change_model_poster` (reemplaza a `set_model_poster` en el panel) registra el poster y, en la misma transacción, **abre un borrador** en cada tour cuya revisión de trabajo es la publicada que usa esa versión. Los visitantes ven la imagen nueva cuando el tour se publica de nuevo, como con cualquier cambio; el panel lo dice al guardar la imagen;
- la publicación del tour **copia siempre el poster actual** de cada modelo, aunque el modelo ya sea público (un archivo pequeño; si ya está, cuenta como copiado), y la base vuelve a medir la versión para la cuota;
- la revisión anterior conserva su imagen para «Volver a esta versión».

Encontrado al revisar la limpieza: al borrar un panorama o un modelo, el ejecutor solo listaba la carpeta de la versión y no sus subcarpetas (`panorama/`, `panorama/tiles/…`, `model/`), así que sus derivados quedaban en Storage. Ahora recorre las subcarpetas. En producción no se había borrado ningún medio todavía.
