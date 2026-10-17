/**
 * Request headers set by the proxy for the render layer. Any incoming header with an
 * internal prefix is deleted before ours are set, so clients cannot inject them.
 */
export const TENANT_CONTEXT_HEADER = "x-rikuy-tenant-context";

const INTERNAL_PREFIXES = ["x-rikuy-", "x-tenant"];

export function stripInternalHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of [...headers.keys()]) {
    if (INTERNAL_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix))) {
      headers.delete(name);
    }
  }
  return headers;
}
