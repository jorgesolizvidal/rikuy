import type { ResolvedPresentation } from "./branding";

/** Icon sizes generated for every portal (favicon, Apple touch icon, PWA icons). */
export const PORTAL_ICON_SIZES = [32, 180, 192, 512] as const;
export type PortalIconSize = (typeof PORTAL_ICON_SIZES)[number];

export function isPortalIconSize(value: number): value is PortalIconSize {
  return (PORTAL_ICON_SIZES as readonly number[]).includes(value);
}

/** Public path of a generated icon; the version busts caches when the brand changes. */
export function portalIconPath(size: PortalIconSize, configId: string | null): string {
  return `/icon/${size}${configId ? `?v=${configId}` : ""}`;
}

/** Web App Manifest for a portal, built only from validated presentation data. */
export function buildWebManifest(resolved: ResolvedPresentation, lang: string) {
  const { presentation, palette, configId } = resolved;
  return {
    name: presentation.identity.siteName,
    short_name: presentation.identity.shortName,
    ...(presentation.seo.description ? { description: presentation.seo.description } : {}),
    lang,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: palette.background,
    theme_color: palette.brand,
    icons: [
      { src: portalIconPath(192, configId), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: portalIconPath(512, configId), sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: portalIconPath(512, configId),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
