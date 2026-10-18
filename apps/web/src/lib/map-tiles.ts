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

/**
 * Base map of the public portal (ADR-023): OpenFreeMap vector tiles drawn with MapLibre,
 * free for public and commercial use without keys. The style URL is configuration, so
 * another provider (paid or self-hosted) can replace it without code changes.
 */
export const PORTAL_MAP = {
  styleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty",
  /** MapLibre's worker, copied to public/ by scripts/vendor-maplibre.mjs. */
  workerUrl: `/vendor/maplibre-gl/${process.env.NEXT_PUBLIC_MAPLIBRE_VERSION ?? "unknown"}/maplibre-gl-worker.mjs`,
} as const;
