# Presupuesto de rendimiento

La velocidad de carga es un **contrato verificable**, no una intención. Estos objetivos se miden en CI y en producción; un PR que los rompa no se mergea sin una excepción documentada.

## Objetivos (móvil, red 4G, percentil 75 de usuarios reales)

| Métrica                         | Objetivo                       | Dónde se mide                         |
| ------------------------------- | ------------------------------ | ------------------------------------- |
| LCP (Largest Contentful Paint)  | ≤ 2,5 s                        | Lighthouse CI · Vercel Speed Insights |
| INP (Interaction to Next Paint) | ≤ 200 ms                       | Speed Insights                        |
| CLS (Cumulative Layout Shift)   | ≤ 0,1                          | Lighthouse CI · Speed Insights        |
| TTFB portal (página cacheada)   | ≤ 0,8 s                        | Speed Insights                        |
| Lighthouse Performance (mobile) | ≥ 90 en home, destino y evento | Lighthouse CI                         |

## Presupuestos de peso

| Recurso                                | Tope                                           | Regla                                                                                                                 |
| -------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| JavaScript inicial de una ruta pública | ≤ 170 KB gzip                                  | Sin visor 360°, three.js, Leaflet ni SDKs de IA en el bundle inicial                                                  |
| Visor 360° (PSV + three)               | Chunk aparte                                   | `import()` dinámico; precarga al mostrar intención (hover / tarjeta visible)                                          |
| Preview de panorama                    | ≤ 40 KB                                        | Visible en < 1 s en 4G; la versión nítida aparece encima                                                              |
| Panorama monolítico (≤ 4096 px)        | ≤ 1,5 MB                                       | WebP q≈85–90; > 4096 px se entrega en tiles (ADR-020)                                                                 |
| Imágenes de contenido                  | Responsive AVIF/WebP                           | `next/image` con `sizes` correcto; hero con `priority`                                                                |
| GLB optimizado                         | ≤ 5 MB (aviso), ≤ 15 MB (rechazo sin revisión) | Meshopt + KTX2 verificado ([ADR-026](adr/ADR-026-glb-pipeline.md)); carga solo al abrir el hotspot, con imagen poster |
| Fuentes tipográficas                   | ≤ 2 familias, subset latino                    | Autoalojadas, `font-display: swap`                                                                                    |

**Mapa (`/mapa`):** MapLibre se carga con `import()` dinámico solo en esta página y, en las fichas, cuando el visitante llega al mapa pequeño (al desplazarse o tocarlo), así que home, destino y evento no pagan su costo. En `/mapa` la lista de lugares es lo primero que se pinta (LCP); el mapa aparece después. Desde el Hito · Paso 3 tiene umbral propio ([ADR-035](adr/ADR-035-free-plan-operations.md)): rendimiento ≥ 60, LCP ≤ 3,5 s, CLS ≤ 0,1 y JS ≤ 700 KB gzip. Lighthouse da 67–69 en el CI y 68 en producción: el arranque de WebGL y MapLibre (~600 KB de JS) pesa en un celular simulado con CPU ×4. En un celular real se mide con `/mapa?medir` (arranque del mapa, primera vista completa, datos y fluidez al moverlo). Medición en Android (2026-10-31, CRT-NX3, Mali-G57 MC2, 4G, producción): LCP 1,99 s, mapa completo a los 3,25 s (0,89 s desde su arranque) y 82 cuadros/s al moverlo, sin cuadros de más de 50 ms. El umbral queda en 60: el celular real va holgado y el laboratorio simula uno más lento. El panel no ve el peso de las teselas: vienen de otro dominio y las pide el _worker_ de MapLibre.

**Tour 360° (`/destinos/{dirección}/tour`, `/agenda/{dirección}/tour`):**

- Lo primero en pantalla (LCP) es la vista previa borrosa de la entrada, precargada con prioridad alta, junto con el texto del tour.
- three.js y Photo Sphere Viewer (~200 KB gzip) se cargan con `import()` después de `load`, cuando el navegador queda libre. Luego se pide solo la imagen o las teselas de la escena en pantalla.
- La ficha del destino o evento no pide ningún archivo del panorama.
- Un punto de modelo 3D muestra su imagen; el visor 3D (~56 KB gzip, sobre el three.js que ya cargó el panorama) y el GLB se piden solo al pulsar «Ver en 3D» (RC-08, [ADR-033](adr/ADR-033-tour-models.md)). Al cerrarlo se libera el contexto WebGL.
- **Umbral propio desde P4 · Paso 7** (`tour` y `generalTour` en `lighthouse-budget.json`): rendimiento ≥ 70, LCP ≤ 3 s, CLS ≤ 0,1 y JS ≤ 380 KB gzip. El LCP empezó en 2,5 s y pasó a 3 s con la medición final:
  - en producción, Lighthouse simulado da 2,5–2,9 s en dos corridas (la vista previa se pide a Storage, en otro dominio);
  - en el CI da 2,4 s;
  - en el celular real, 0,68 s. El JS incluye three.js y Photo Sphere Viewer, que se cargan después de `load`. En el CI (mediana de 3), las dos primeras corridas dieron rendimiento 79 y 88, LCP 2,4 s y TBT 0,4–0,76 s, en el tour de una escena y en `/recorrido`.
- Se miden las páginas de tour que haya en el sitemap de cada portal (en el PR, las que deja RC-07 en Demo Sur; en producción, las publicadas). La lista de contratos está en [contratos de los tours](contratos-tours.md).
- **En el dispositivo:** con `?medir` en la dirección de un tour, un panel mide la carga, 20 cambios de escena, la fluidez, la memoria JS y el modelo 3D, y deja el resultado como texto para copiar. No se carga sin ese parámetro y no envía nada.

## Reglas de implementación

1. Server Components por defecto; Client Components solo para interacción (mapa, visor, formularios).
2. Páginas públicas cacheadas por `tenant + idioma + versión publicada`; invalidación por tags al publicar.
3. Assets publicados con URL versionada e inmutable (`Cache-Control: public, max-age=31536000, immutable`).
4. Cero requests de GLB o tiles antes de que el usuario abra el tour o el hotspot.
5. Cambio rápido de escena: cancelar descargas de la escena anterior (verificado en P0).

## Calendario

- **P1:** baseline de bundle registrado en cada PR.
- **P3 · Paso 7 ✅:** Lighthouse CI en cada PR (job «Contracts · Lighthouse budget»): compilación de producción y base local con el seed, móvil con 4G y CPU ×4 simulados, mediana de 3 corridas por página. Los umbrales viven en [`apps/web/lighthouse-budget.json`](../apps/web/lighthouse-budget.json): rendimiento ≥ 90, LCP ≤ 2,5 s, CLS ≤ 0,1 y JS ≤ 170 KB gzip en inicio, destinos, ficha de destino, agenda y ficha de evento de los dos municipios; accesibilidad, buenas prácticas y SEO ≥ 95 en todas. `/mapa` tiene su propio umbral desde el Hito · Paso 3. Los informes quedan como artefacto del job.
- **P3 · Paso 8 ✅:** el mismo presupuesto sobre producción tras cada merge (workflow «Lighthouse on production»), páginas del portal en la caché de Vercel por municipio ([ADR-024](adr/ADR-024-portal-page-cache.md)) y Speed Insights activo. Un portal sin nada publicado (sin destinos ni eventos próximos en su sitemap) lleva `noindex` a propósito: su SEO se juzga sin la auditoría de rastreo (`is-crawlable`). Un portal con contenido se juzga con todo, así que un `noindex` indebido sigue fallando.
- **P4 ✅:** medición del tour en Android físico de gama media. La primera fue tras el Paso 4, en producción (funciona bien, sin números). La final, el 2026-10-27 con `?medir` en un CRT-NX3 (Android 15, Mali-G57): primera escena en 1,5 s, cambios de escena con p95 de 0,95 s, 87 cuadros/s al girar y modelo 3D en 3,6 s. El detalle y los límites están en [contratos de los tours](contratos-tours.md).
- **Hito demo:** Speed Insights activo en producción.
