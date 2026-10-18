import { isPortalIconSize, monogram } from "@rikuy/core";
import { ImageResponse } from "next/og";

import { portalView } from "@/server/portal-view";

interface IconContext {
  readonly params: Promise<{ host: string; size: string }>;
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** The published PNG derivative as a data URI, or null (missing, too big, unreachable). */
async function logoDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok || response.headers.get("content-type") !== "image/png") return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > LOGO_MAX_BYTES) return null;
    return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Generated portal icon (favicon, Apple touch icon, PWA icons): the published logo on the
 * portal background, or the tenant's monogram on its brand color when there is no logo
 * (or it cannot be read), so every portal stays installable and recognizable.
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
  const logo = view.logo ? await logoDataUri(view.logo.png) : null;
  // A fallback icon must not be cached forever: the logo may be reachable on the next try.
  const immutable = versioned && (view.logo === null || logo !== null);
  const inner = Math.round(pixels * 0.8);

  return new ImageResponse(
    logo ? (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: palette.background,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={logo} width={inner} height={inner} style={{ objectFit: "contain" }} />
      </div>
    ) : (
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
      </div>
    ),
    {
      width: pixels,
      height: pixels,
      headers: {
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
      },
    },
  );
}
