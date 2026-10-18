# ADR-023 — Mapa del portal: OpenFreeMap con MapLibre

- **Estado:** Aceptada — 2026-10-18
- **Relacionada con:** ADR-010 (mapas con licencia apropiada), ADR-021 (ubicación del visitante), presupuesto de rendimiento
- **Decisión del usuario:** proveedor elegido entre las opciones presentadas en P3 · Paso 5

## Contexto

El panel usa Leaflet con las teselas estándar de OpenStreetMap: está bien para pocos editores, pero su política de uso no admite el tráfico de un portal público y bloquea a quien no la cumple (lo vimos en el panel, con «403 Access blocked», por la cabecera `Referer`). El portal necesita un mapa para muchos visitantes, con uso comercial permitido (municipios) y sin costos fijos en el piloto.

Opciones revisadas (octubre de 2026):

| Opción                            | Costo                                                                         | Uso comercial      | Librería           |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------ | ------------------ |
| OpenFreeMap (teselas vectoriales) | Gratis, sin clave ni límite de vistas                                         | Sí, con atribución | MapLibre           |
| Stadia Maps                       | Gratis no permite uso comercial; desde USD 20/mes                             | Solo de pago       | Leaflet o MapLibre |
| MapTiler                          | Gratis: 5000 cargas/mes, se pausa al pasarlas, no comercial; desde USD 30/mes | Solo de pago       | Leaflet o MapLibre |

## Decisión

1. **El portal usa OpenFreeMap** (estilo `liberty`) dibujado con **MapLibre GL JS**, con la atribución «OpenFreeMap © OpenMapTiles · Datos de OpenStreetMap» que el estilo trae.
2. **El estilo es configuración**: `NEXT_PUBLIC_MAP_STYLE_URL`. Cambiar a un proveedor pagado o a teselas propias (por ejemplo PMTiles en Storage) no requiere tocar código.
3. **MapLibre nunca entra en el bundle inicial**: se carga con `next/dynamic` solo en `/mapa` y, en las fichas, cuando el mapa pequeño está por verse. Su _worker_ se sirve desde nuestro dominio (`/vendor/maplibre-gl/<versión>/`, generado al compilar y fuera de git).
4. **Consultas por área**: el mapa pide al servidor solo los lugares de la zona visible (`portal_map_places`, índice GiST), con un tope por petición; nunca descarga el catálogo completo.
5. **Siempre hay alternativa textual**: la lista de lugares junto al mapa, las coordenadas y «Cómo llegar». Si el mapa no carga (sin WebGL, servicio caído), la página lo dice y la lista sigue funcionando.
6. El **panel** sigue con Leaflet + OpenStreetMap (uso ligero, ya con el `Referer` correcto).

## Consecuencias

- (+) Sin costos ni claves en el piloto; uso comercial permitido.
- (+) Proveedor intercambiable por configuración.
- (−) OpenFreeMap no ofrece garantía de servicio (SLA). Mitigación: la alternativa textual y el cambio de estilo por configuración; si un municipio exige SLA, se contrata un proveedor o se sirven teselas propias.
- (−) MapLibre pesa más que Leaflet (~300 KB comprimido), por eso solo se carga donde hay mapa.
- (−) El navegador del visitante pide las teselas a OpenFreeMap (recibe su IP); la página de privacidad lo explica.
