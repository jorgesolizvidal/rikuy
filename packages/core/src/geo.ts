/**
 * @rikuy/core/geo — distances, areas and «Estás cerca de…», without schemas.
 *
 * Browser code imports this entry instead of "@rikuy/core": the main entry also carries the
 * zod contracts, which cannot be tree-shaken and would add ~35 KB to every portal page.
 */
export * from "./domain/geo/bounds";
export * from "./domain/geo/proximity";
export type { GeoPoint } from "./contracts/destination";
