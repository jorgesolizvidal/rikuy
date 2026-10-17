import { isPortalIconSize, monogram } from "@rikuy/core";
import { ImageResponse } from "next/og";

import { portalView } from "@/server/portal-view";

interface IconContext {
  readonly params: Promise<{ host: string; size: string }>;
}

/**
 * Generated portal icon (favicon, Apple touch icon, PWA icons): the tenant's monogram on
 * its brand color. Until a municipality uploads a logo (P3) this keeps every portal
 * installable and recognizable without storing any image.
 */
export async function GET(request: Request, { params }: IconContext) {
  const { host, size } = await params;
  const pixels = Number(size);
  if (!isPortalIconSize(pixels)) return new Response("Not found", { status: 404 });

  const view = await portalView(host);
  if (view === null) return new Response("Not found", { status: 404 });

  const { palette, presentation, configId } = view.resolved;
  // URLs carry ?v=<sealed config id>: a matching version can be cached forever.
  const versioned = configId !== null && new URL(request.url).searchParams.get("v") === configId;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: palette.brand,
        color: palette.onBrand,
        fontSize: Math.round(pixels * 0.4),
        fontWeight: 700,
        letterSpacing: "-0.02em",
      }}
    >
      {monogram(presentation.identity.shortName)}
    </div>,
    {
      width: pixels,
      height: pixels,
      headers: {
        "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300",
      },
    },
  );
}
