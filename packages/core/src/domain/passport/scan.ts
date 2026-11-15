import { isStampCode, type PassportStamp } from "./stamps";

/**
 * The passport's page in the browser (C3 · Paso 5, ADR-064): what a scanned QR means and which
 * stop comes next. Pure and without schemas: the browser uses it through
 * `@rikuy/core/passport-client`.
 */

export type ScannedCode =
  /** A stamp code of THIS portal: the path of its page. */
  | { readonly kind: "stamp"; readonly path: string }
  /** A link to another site, or to this portal but not a stamp. */
  | { readonly kind: "other" }
  /** Text that is not a link. */
  | { readonly kind: "text" };

/**
 * What a QR read by the camera says. Only a stamp of the same portal (its origin and
 * `/sello/{code}`) is opened: the scanner never navigates to another site, so a sticker over the
 * real code cannot send the visitor elsewhere.
 */
export function readScannedCode(raw: string, origin: string): ScannedCode {
  let url: URL;
  let base: URL;
  try {
    base = new URL(origin);
    url = new URL(raw.trim());
  } catch {
    return { kind: "text" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "other" };
  if (url.origin !== base.origin) return { kind: "other" };
  const match = /^\/sello\/([^/]+)\/?$/u.exec(url.pathname);
  const code = match?.[1] ? decodeURIComponent(match[1]) : null;
  if (code === null || !isStampCode(code)) return { kind: "other" };
  return { kind: "stamp", path: `/sello/${code}` };
}

/**
 * The stop the circuit suggests next: the first one in its order without this phone's stamp.
 * Nothing is locked (any order counts, ADR-056); null once every stop is stamped.
 */
export function nextSuggestedStop(
  stopIds: readonly (string | null)[],
  stamps: Readonly<Record<string, PassportStamp>>,
): number | null {
  const index = stopIds.findIndex((id) => id === null || stamps[id] === undefined);
  return index === -1 ? null : index;
}
