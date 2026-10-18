/**
 * Base map for the admin location picker. OpenStreetMap's standard tiles are fine for
 * this light, interactive use (attribution required, no bulk downloads). The public
 * portal map chooses a provider with an appropriate license in P3 · Paso 5 (ADR-010).
 */
export const ADMIN_TILES = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
  /** OSM requires a Referer; send only the origin (e.g. `https://app.example/`). */
  referrerPolicy: "strict-origin",
} as const;
