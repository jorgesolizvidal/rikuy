import "server-only";

/**
 * What every POST of a portal checks (ADR-038, ADR-041): it comes from a page of this same
 * portal (Origin), and the visitor's limits count by address (the database keeps only a
 * daily-salted hash of it).
 */
export function fromSamePortal(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  try {
    return origin !== null && host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function visitorKey(request: Request): string | null {
  const address =
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  return address?.slice(0, 64) ?? null;
}
