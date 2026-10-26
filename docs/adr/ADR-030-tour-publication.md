# ADR-030 — Publicar un tour: medios públicos antes de sellar y un manifiesto por revisión

- **Estado:** Aceptada — 2026-10-26
- **Concreta:** ADR-017 y ADR-020 (los derivados quedan privados hasta que un tour los use), FUN-02 del sistema anterior (el tour descargaba todos los hotspots)

## Contexto

Los panoramas, las fotos de los puntos y los modelos 3D quedan en el bucket privado mientras se editan. El visitante necesita leerlos sin sesión, con caché larga. El portal también necesita saber exactamente qué muestra una versión publicada, sin leer las tablas del editor ni descargar todo el municipio.

## Decisión

1. **Al publicar, primero se copian los medios al bucket público; después se sella.**
   - Qué se copia:
     - de cada panorama, la vista previa, la imagen y **todas sus teselas**;
     - de cada modelo 3D, el `.glb` optimizado y su poster;
     - de cada punto, sus fotos.
   - Lo que ya es público, porque otro tour lo usa o porque ya se publicó antes, no se vuelve a copiar.
   - `publish_tour` exige que todo esté **publicado**, no solo listo. Si la copia falla, no se sella nada.
2. **Las copias se hacen dentro de Storage** (`copy` entre buckets): los bytes no pasan por el servidor. Un archivo que ya existe cuenta como copiado. Las fotos siguen el camino de las imágenes (re-subida con su tipo).
3. **Una versión se marca publicada solo después de que sus archivos están en el bucket público.** Así la medición de la cuota (ADR-027) incluye las copias públicas. Las imágenes de destinos y eventos pasan a seguir el mismo orden; antes se marcaban primero.
4. **La revisión sellada guarda su manifiesto público.**
   - Contiene:
     - las escenas, con la carpeta pública de cada panorama, su vista previa, imagen y teselas;
     - los puntos con su texto, sus fotos con tamaño y el archivo del modelo con su poster;
     - las flechas a otras escenas;
     - el destino de cada «ir a otro recorrido», por identificador de contenido.
   - No lleva nada del editor (números de edición, estados).
   - Es inmutable como el resto de la revisión. Volver a una versión sirve su propio manifiesto.
   - Las revisiones ya selladas reciben el suyo al migrar.
5. **Lecturas anónimas:**
   - `portal_tour`: un tour, por el tipo y la dirección de su destino o evento. Trae los «ir a otro recorrido» ya resueltos; los que no tienen un tour visible se omiten.
   - `portal_tour_index`: los tours visibles, con la vista previa de su escena de entrada, para el recorrido general.
   - Solo municipios activos, contenido publicado y tour publicado. Un evento terminado conserva la página de su tour pero sale del índice.
6. **El bucket público acepta modelos GLB hasta 15 MB** (límite del optimizado, ADR-026). Los derivados se guardan con `Cache-Control` de un año, porque sus rutas están versionadas.
7. **Publicar o volver a una versión invalida la caché del portal solo de ese municipio** (ADR-024).

## Consecuencias

- (+) El portal lee una sola fila por tour y descarga solo la escena que muestra. La vista previa del índice basta para el menú del recorrido general.
- (+) Un archivo público nunca cambia: caché de un año en el navegador y en la CDN de Storage.
- (−) Publicar el primer tour con un panorama de 8K copia unos 170 archivos. Dentro de Storage tarda pocos segundos; el panel muestra «Publicando…» mientras tanto.
- (−) Un medio que dejó de usarse sigue público. Retirarlo llegará con la limpieza de medios huérfanos.
