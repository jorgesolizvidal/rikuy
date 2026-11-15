/**
 * @rikuy/core/passport-client — the stamps the phone keeps (ADR-057), without schemas, for
 * browser code (the main entry carries the zod contracts).
 */
export * from "./domain/passport/stamps";
export * from "./domain/passport/rewards";
// What a scanned QR means and the stop that comes next (C3 · Paso 5, ADR-064).
export * from "./domain/passport/scan";
