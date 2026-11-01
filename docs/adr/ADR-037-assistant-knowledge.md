# ADR-037 — Conocimiento del asistente: fragmentos de lo publicado, búsqueda en español y citas

- **Estado:** Aceptada — 2026-10-31
- **Concreta:** ADR-022, ADR-036 y el cierre de P0 (D5, D6) para el roadmap P5 · Paso 2

## Contexto

El asistente del visitante (Paso 3) tiene que responder con lo que el municipio publicó y citarlo. En el sistema anterior, el «libro histórico» era un archivo de texto en el servidor, con secciones y palabras clave. No tenía versiones, no se podía retirar y no tenía citas.

Condiciones:

- Solo planes gratuitos: sin embeddings de pago ni base vectorial (D6). La búsqueda empieza con texto completo de PostgreSQL en español, sin distinguir tildes.
- **Un borrador o un documento retirado nunca aparece en una respuesta** (criterio del paso). No puede depender de que un trabajo de reindexación termine a tiempo.
- La auditoría (11, 13) modela el conocimiento como un tipo de contenido con revisiones y `knowledge_chunks` ligados a la revisión de origen. Las citas llevan fuente, versión y fragmento (D5).

Decisiones del usuario (2026-10-31):

- Los documentos de conocimiento **solo los usa el asistente**: no tienen página pública ni descarga. La cita muestra el título y la página.
- Formatos: **TXT y PDF con texto**. Un PDF escaneado se rechaza con su motivo; el OCR queda para después.
- Los textos de los **tours 360°** (descripción de cada escena y puntos de información o de modelo) entran ya en el conocimiento.
- Para probar a mano se usa una copia local del libro histórico del sistema anterior. Nunca entra al repositorio.

## Decisión

1. **«Conocimiento del asistente» es un tipo de contenido** (`knowledge`), con el mismo flujo que destinos y eventos: borrador, publicar, versiones selladas y «Volver a esta versión». Cada revisión tiene título, resumen, texto propio (el mismo formato de los destinos) y, opcionalmente, **un documento**. A diferencia de destinos y eventos, se puede **retirar**: el puntero publicado queda vacío y la revisión sigue sellada, así que se puede volver a publicar.
2. **Documentos como medios** (`asset_purpose = 'document'`, hasta 20 MB). El navegador sube el original al bucket privado y `submit_document` encola `media.extract_document`. El ejecutor revisa los bytes reales (PDF o texto UTF-8/Windows-1252) y extrae el texto por página. El texto queda junto al original (`…/document/text.json`) y en un manifiesto (formato, páginas, caracteres). Rechaza con motivo un PDF sin texto, uno protegido con contraseña o un archivo que no es lo que dice ser. En un TXT, las marcas de página impresas («14 |», «| 15») se usan como páginas si hay al menos tres.
3. **Fragmentos solo de revisiones selladas.** Cuando cambia el puntero publicado de un contenido o de un tour (publicar, volver a una versión), un trigger encola `knowledge.index` para esa revisión, en la misma transacción. El indexador arma los fragmentos en `@rikuy/core` (determinista, versión de fragmentación 1) y los guarda con `worker_api.store_knowledge_chunks`, que los reemplaza todos de una vez:
   - texto en bloques de unos 1.500 caracteres, que respetan secciones y párrafos y repiten la última oración del fragmento anterior;
   - cada fragmento lleva el título de su fuente y la sección (o escena, o punto del tour), la página si la hay, y una huella SHA-256;
   - destinos y eventos aportan título, resumen y texto; los eventos, además, su fecha y su lugar escritos en palabras.

   Los fragmentos de una revisión sellada no cambian y se conservan: volver a una versión anterior reutiliza los suyos.

4. **Visibilidad comprobada en cada búsqueda, no al indexar.** La búsqueda une cada fragmento con el puntero publicado **actual** de su contenido o de su tour, del mismo municipio. Un borrador nunca tiene fragmentos, y un documento retirado o reemplazado deja de aparecer en la misma transacción que lo retira, sin esperar a ningún trabajo. Los tours, además, exigen que su destino o evento esté publicado. Los eventos terminados aparecen marcados como tales.
5. **Búsqueda de texto completo en español** con `unaccent` (función inmutable propia) y una columna `tsvector` generada: el título y la sección pesan más que el texto. La pregunta se reduce a sus palabras con contenido (sin palabras vacías), que se buscan con «o». El orden combina cuántas de esas palabras aparecen en el fragmento con `ts_rank_cd`. Hasta 8 resultados.
   - `ai_api.search_knowledge` (rol `rikuy_ai`, municipios en línea) es lo que usará el asistente;
   - `search_tenant_knowledge` (cualquier miembro) alimenta «Probar la búsqueda» en el panel y no gasta tokens.
6. **Citas (D5).** Cada resultado trae `{fuente: content | tour, sourceId, sourceVersion, chunkId}`. El núcleo valida que una cita exista dentro de lo recuperado (`validateCitations`) y arma la cita pública:
   - título y página;
   - enlace a la ficha o al tour (con su escena) para destinos, eventos y tours;
   - sin enlace para los documentos, que solo usa el asistente.
7. **Cuotas:** el documento cuenta en el almacenamiento (original + texto extraído) y su extracción en el procesamiento, igual que panoramas y modelos. Los fragmentos viven en la base y no cuentan en la cuota del municipio, pero sí en los 500 MB del proyecto, que ya vigila el informe diario.

## Consecuencias

- (+) El criterio del paso no depende del tiempo de un trabajo: lo garantiza la consulta.
- (+) Volver a una versión es instantáneo para el asistente, porque sus fragmentos ya existen.
- (+) Sin proveedores nuevos: PostgreSQL y pdf.js.
- (−) Entre publicar y terminar la indexación (segundos), la versión nueva aún no tiene fragmentos y la fuente no aparece. Se prefiere a mostrar la versión anterior.
- (−) El texto completo no entiende sinónimos ni preguntas en inglés. El asistente (Paso 3) reformula la pregunta en español antes de buscar; los embeddings se evalúan después (D6).
- (−) Los fragmentos de revisiones viejas ocupan espacio en la base. Se limpiarán con la retirada de medios sin uso.
