import "../../portal/[host]/portal.css";
import "./ask.css";

import { portalIconPath, themeCssVariables } from "@rikuy/core";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { preload } from "react-dom";

import { THEME_FONTS, themeFontFaces } from "@/lib/theme-fonts";
import { platformSettings } from "@/server/platform";
import { portalView } from "@/server/portal-view";

/**
 * The assistant's own pages (A · Paso 2, ADR-071): «Pregúntale a …» (what a QR on a sign
 * opens) and the frame the municipality's website shows. Outside the portal's layout: the
 * municipality's colors and fonts, and nothing else of the portal. Cached per host like the
 * portal (ADR-024); never indexed.
 */
export const revalidate = 120;

export function generateStaticParams(): { host: string }[] {
  return [];
}

interface AssistantLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({
  params,
}: Omit<AssistantLayoutProps, "children">): Promise<Metadata> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  const { configId, presentation } = view.resolved;
  const { siteName } = presentation.identity;
  const canonicalHost = view.context.tenant.canonicalHost ?? view.context.host;
  return {
    robots: { index: false, follow: false },
    metadataBase: new URL(platformSettings().portalOrigin(canonicalHost)),
    title: { default: siteName, template: `%s | ${siteName}` },
    icons: {
      icon: [{ url: portalIconPath(32, configId), sizes: "32x32", type: "image/png" }],
      apple: [{ url: portalIconPath(180, configId), sizes: "180x180", type: "image/png" }],
    },
  };
}

export async function generateViewport({
  params,
}: Omit<AssistantLayoutProps, "children">): Promise<Viewport> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  return { themeColor: view.resolved.palette.brand, colorScheme: view.resolved.palette.mode };
}

export default async function AssistantLayout({ children, params }: AssistantLayoutProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  const { palette } = view.resolved;
  const font = THEME_FONTS[palette.style];
  preload(font.href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  return (
    <div
      className="portal ask"
      data-theme={palette.style}
      data-mode={palette.mode}
      lang={view.context.tenant.defaultLocale}
      // Validated #rrggbb values only (see themeCssVariables).
      style={themeCssVariables(palette) as CSSProperties}
    >
      <style href={`rikuy-font-${palette.style}`} precedence="default">
        {themeFontFaces(palette.style)}
      </style>
      {children}
    </div>
  );
}
