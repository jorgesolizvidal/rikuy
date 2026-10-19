import { buildWebManifest } from "@rikuy/core";

import { portalView } from "@/server/portal-view";

/** Resolved per request: these small responses carry their own Cache-Control. */
export const dynamic = "force-dynamic";

interface ManifestContext {
  readonly params: Promise<{ host: string }>;
}

/** Per-tenant Web App Manifest, served at `/manifest.webmanifest` on every portal host. */
export async function GET(_request: Request, { params }: ManifestContext) {
  const view = await portalView((await params).host);
  if (view === null) return new Response("Not found", { status: 404 });

  return Response.json(buildWebManifest(view.resolved, view.context.tenant.defaultLocale), {
    headers: {
      "content-type": "application/manifest+json",
      // Stable URL whose content changes on publish: short cache only.
      "cache-control": "public, max-age=300",
    },
  });
}
