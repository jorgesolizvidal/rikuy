/**
 * Public media (photos, logo) from the portal's own address (ADR-050): `/medios/{path}` is
 * forwarded to the public bucket by the CDN, which keeps a copy. apps/web/vercel.json opts
 * the rewrite into caching and adds its headers (a sandboxing Content-Security-Policy: they
 * are tenant files on the portal's origin). The proxy does not run on these paths (its
 * matcher skips them). Read by next.config.ts: no imports from the workspace packages here.
 */

/** MEDIA_BUCKETS.public of @rikuy/db (a test checks they agree). */
export const PUBLIC_MEDIA_BUCKET = "media-public";

export function mediaRewrite(supabaseUrl: string | undefined) {
  if (!supabaseUrl) return [];
  const storage = `${supabaseUrl.replace(/\/+$/u, "")}/storage/v1/object/public`;
  return [{ source: "/medios/:path*", destination: `${storage}/${PUBLIC_MEDIA_BUCKET}/:path*` }];
}
