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

| Recurso                                | Tope                                           | Regla                                                                        |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| JavaScript inicial de una ruta pública | ≤ 170 KB gzip                                  | Sin visor 360°, three.js, Leaflet ni SDKs de IA en el bundle inicial         |
| Visor 360° (PSV + three)               | Chunk aparte                                   | `import()` dinámico; precarga al mostrar intención (hover / tarjeta visible) |
| Preview de panorama                    | ≤ 40 KB                                        | Visible en < 1 s en 4G; la versión nítida aparece encima                     |
| Panorama monolítico (≤ 4096 px)        | ≤ 1,5 MB                                       | WebP q≈85–90; > 4096 px se entrega en tiles (ADR-020)                        |
| Imágenes de contenido                  | Responsive AVIF/WebP                           | `next/image` con `sizes` correcto; hero con `priority`                       |
| GLB optimizado                         | ≤ 5 MB (aviso), ≤ 15 MB (rechazo sin revisión) | Meshopt/Draco + KTX2; carga solo al abrir el hotspot, con imagen poster      |
| Fuentes tipográficas                   | ≤ 2 familias, subset latino                    | Autoalojadas, `font-display: swap`                                           |

**Mapa (`/mapa`):** MapLibre se carga con `import()` dinámico solo en esta página y, en las fichas, cuando el visitante llega al mapa pequeño (al desplazarse o tocarlo), así que home, destino y evento no pagan su costo. En `/mapa` la lista de lugares es lo primero que se pinta (LCP); el mapa aparece después. En laboratorio (móvil, CPU ×4) `/mapa` queda en torno a 60–70 de rendimiento por el arranque de WebGL: se mide en dispositivos reales con Lighthouse CI y Speed Insights (P3 · Paso 7) antes de fijarle un objetivo propio.

## Reglas de implementación

1. Server Components por defecto; Client Components solo para interacción (mapa, visor, formularios).
2. Páginas públicas cacheadas por `tenant + idioma + versión publicada`; invalidación por tags al publicar.
3. Assets publicados con URL versionada e inmutable (`Cache-Control: public, max-age=31536000, immutable`).
4. Cero requests de GLB o tiles antes de que el usuario abra el tour o el hotspot.
5. Cambio rápido de escena: cancelar descargas de la escena anterior (verificado en P0).

## Calendario

- **P1:** baseline de bundle registrado en cada PR.
- **P3 · Paso 7 ✅:** Lighthouse CI en cada PR (job «Contracts · Lighthouse budget»): compilación de producción y base local con el seed, móvil con 4G y CPU ×4 simulados, mediana de 3 corridas por página. Los umbrales viven en [`apps/web/lighthouse-budget.json`](../apps/web/lighthouse-budget.json): rendimiento ≥ 90, LCP ≤ 2,5 s, CLS ≤ 0,1 y JS ≤ 170 KB gzip en inicio, destinos, ficha de destino, agenda y ficha de evento de los dos municipios; accesibilidad, buenas prácticas y SEO ≥ 95 en todas. `/mapa` solo tiene CLS y esas tres categorías hasta medirlo en un celular real. Los informes quedan como artefacto del job.
- **P3 · Paso 8 ✅:** el mismo presupuesto sobre producción tras cada merge (workflow «Lighthouse on production»), páginas del portal en la caché de Vercel por municipio ([ADR-024](adr/ADR-024-portal-page-cache.md)) y Speed Insights activo.
- **P4:** medición del tour en Android físico de gama media (pendiente desde P0).
- **Hito demo:** Speed Insights activo en producción.
