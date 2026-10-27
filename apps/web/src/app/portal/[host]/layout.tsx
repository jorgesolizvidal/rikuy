import "./portal.css";

import { PORTAL_PATHS, monogram, portalIconPath, themeCssVariables } from "@rikuy/core";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

import { platformSettings } from "@/server/platform";
import { portalTourIndex } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { SpeedInsights } from "@vercel/speed-insights/next";

import { InstallButton } from "./install-button";
import { SocialLinks } from "./social-links";

/**
 * The portal's display face (titles), self-hosted and preloaded with the page: as a plain
 * stylesheet font it was found only after the CSS, one more round trip before the first
 * paint of every page. Latin covers Spanish; other characters use the fallback face.
 */
const display = localFont({
  src: "../../../../node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2",
  weight: "200 800",
  display: "swap",
  variable: "--font-portal-display",
  fallback: ["system-ui", "sans-serif"],
});

/**
 * Portal pages are cached per host and rebuilt at most every 2 minutes (ADR-024): enough
 * for an event that just ended to leave the agenda, while publishing refreshes the
 * tenant's pages at once (server/portal-cache.ts). Pages that read the query string
 * (/mapa) stay dynamic.
 */
export const revalidate = 120;

/** No host is known at build time: each portal page is rendered on its first visit, then cached. */
export function generateStaticParams(): { host: string }[] {
  return [];
}

interface PortalLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({
  params,
}: Omit<PortalLayoutProps, "children">): Promise<Metadata> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  const { presentation, configId } = view.resolved;
  const { siteName, shortName } = presentation.identity;
  const description = presentation.seo.description || undefined;
  const canonicalHost = view.context.tenant.canonicalHost ?? view.context.host;

  return {
    metadataBase: new URL(platformSettings().portalOrigin(canonicalHost)),
    title: { default: siteName, template: `%s | ${siteName}` },
    ...(description ? { description } : {}),
    applicationName: shortName,
    alternates: { canonical: "/" },
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [{ url: portalIconPath(32, configId), sizes: "32x32", type: "image/png" }],
      apple: [{ url: portalIconPath(180, configId), sizes: "180x180", type: "image/png" }],
    },
    openGraph: {
      type: "website",
      ...(view.logo ? { images: [{ url: view.logo.png, alt: siteName }] } : {}),
      siteName,
      title: siteName,
      ...(description ? { description } : {}),
      locale: view.context.tenant.defaultLocale.replace("-", "_"),
    },
  };
}

export async function generateViewport({
  params,
}: Omit<PortalLayoutProps, "children">): Promise<Viewport> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  return { themeColor: view.resolved.palette.brand, colorScheme: view.resolved.palette.mode };
}

export default async function PortalLayout({ children, params }: PortalLayoutProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();

  const tours = await portalTourIndex(view);
  const { presentation, palette } = view.resolved;
  const { identity, contact, social } = presentation;
  const hasContact = Boolean(contact.email || contact.phone || contact.address);

  return (
    <div
      className={`portal ${display.variable}`}
      data-mode={palette.mode}
      lang={view.context.tenant.defaultLocale}
      // Validated #rrggbb values only (see themeCssVariables).
      style={themeCssVariables(palette) as CSSProperties}
    >
      <a className="portal-skip" href="#contenido">
        Saltar al contenido
      </a>
      <header className="portal-header">
        <a href="/" className="portal-brand">
          {view.logo ? (
            // Versioned, immutable public derivative (≤512 px WebP); the site name next to it
            // is the accessible name, so the image is decorative.
            // eslint-disable-next-line @next/next/no-img-element
            <img className="portal-logo" src={view.logo.webp} alt="" decoding="async" />
          ) : (
            <span className="portal-mark" aria-hidden="true">
              {monogram(identity.shortName)}
            </span>
          )}
          <span className="portal-brand-name">{identity.siteName}</span>
        </a>
        <nav aria-label="Principal" className="portal-nav">
          <a href={PORTAL_PATHS.destinations}>Destinos</a>
          <a href={PORTAL_PATHS.agenda}>Agenda</a>
          <a href={PORTAL_PATHS.map}>Mapa</a>
          {tours.length > 0 ? <a href={PORTAL_PATHS.generalTour}>Tours 360°</a> : null}
          <InstallButton siteName={identity.siteName} />
        </nav>
      </header>

      <main id="contenido">{children}</main>

      <footer className="portal-footer">
        {hasContact ? (
          <section aria-labelledby="contacto">
            <h2 id="contacto">Contacto</h2>
            <address>
              {contact.address ? <p>{contact.address}</p> : null}
              {contact.phone ? (
                <p>
                  <a href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}>{contact.phone}</a>
                </p>
              ) : null}
              {contact.email ? (
                <p>
                  <a href={`mailto:${contact.email}`}>{contact.email}</a>
                </p>
              ) : null}
            </address>
          </section>
        ) : null}
        {social.length > 0 ? (
          <section aria-labelledby="redes">
            <h2 id="redes">Síguenos</h2>
            <SocialLinks links={social} />
          </section>
        ) : null}
        <nav aria-label="Información legal" className="portal-legal-links">
          <a href={PORTAL_PATHS.privacy}>Privacidad</a>
          <a href={PORTAL_PATHS.terms}>Términos de uso</a>
        </nav>
        <p className="portal-credit">Portal oficial de {identity.siteName}. Funciona con Rikuy.</p>
      </footer>
      {/* Real-user performance (anonymous, no cookies), only where Vercel serves it. */}
      {process.env.VERCEL === "1" ? <SpeedInsights /> : null}
    </div>
  );
}
