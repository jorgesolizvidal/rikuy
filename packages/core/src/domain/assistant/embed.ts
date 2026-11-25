/**
 * «Solo asistente» (A · Paso 2, ADR-071): the websites where a municipality's assistant may be
 * embedded, and the link of each published item to its page on that website. The database
 * checks the same rules (`private.is_valid_embed_origin`, `private.web_link_origin`).
 */

export const EMBED_LIMITS = {
  /** Websites per municipality. */
  origins: 10,
  /** «Página en la web del municipio». */
  url: 500,
} as const;

const HTTPS_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/u;
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/u;

/** An origin as the database keeps it: https with a host name, or http on this machine. */
export function isEmbedOrigin(value: string): boolean {
  return value.length <= 200 && (HTTPS_ORIGIN.test(value) || LOCAL_ORIGIN.test(value));
}

/**
 * The website the operator types, as an origin: «www.muni.gob.bo» or «https://www.muni.gob.bo/»
 * become «https://www.muni.gob.bo». A path, a query, a user name or plain http on the internet
 * are refused (null): the assistant is authorized for a whole website, never part of one.
 */
export function parseEmbedOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const typed = value.trim();
  if (typed === "" || /\s/u.test(typed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return isEmbedOrigin(url.origin) ? url.origin : null;
}

/** The origin of a link, or null when it is not a plain web address on https (or this machine). */
export function webLinkOrigin(value: string): string | null {
  if (value.length > EMBED_LIMITS.url || /[\s\p{Cc}]/u.test(value)) return null;
  const match =
    /^(https:\/\/[a-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)(?:[/?#].*)?$/u.exec(
      value,
    );
  const origin = match?.[1];
  return origin && isEmbedOrigin(origin) ? origin : null;
}

export type WebLinkInput =
  | { readonly status: "ok"; readonly url: string | null }
  | { readonly status: "invalid" }
  /** A web address, but not on one of the municipality's authorized websites. */
  | { readonly status: "origin" };

/**
 * «Página en la web del municipio» as typed in the editor: empty clears it; otherwise a web
 * address on one of the municipality's websites, written the way the browser writes it.
 */
export function parseWebLink(value: unknown, origins: readonly string[]): WebLinkInput {
  if (typeof value !== "string") return { status: "invalid" };
  const typed = value.trim();
  if (typed === "") return { status: "ok", url: null };
  if (/\s/u.test(typed) || typed.length > EMBED_LIMITS.url) return { status: "invalid" };
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return { status: "invalid" };
  }
  if (url.username || url.password) return { status: "invalid" };
  const href = url.href;
  const origin = webLinkOrigin(href);
  if (origin === null) return { status: "invalid" };
  return origins.includes(origin) ? { status: "ok", url: href } : { status: "origin" };
}

/**
 * The script's `data-lugar` (and the frame's `?lugar=`): «destinos/{dirección}» or
 * «agenda/{dirección}», the page of the municipality's website about that place.
 */
export function parseEmbedPlace(
  value: unknown,
): { readonly kind: "destination" | "event"; readonly slug: string } | null {
  if (typeof value !== "string") return null;
  const match = /^\/?(destinos|agenda)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(value.trim());
  if (!match?.[1] || !match[2] || match[2].length > 80) return null;
  return { kind: match[1] === "destinos" ? "destination" : "event", slug: match[2] };
}

/** The Content-Security-Policy of the frame's page: only the municipality's websites show it. */
export function frameAncestors(origins: readonly string[]): string {
  return ["'self'", ...origins.filter(isEmbedOrigin)].join(" ");
}
