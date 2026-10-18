import "@fontsource-variable/bricolage-grotesque";
import "./portal.css";

import { PORTAL_PATHS, monogram, portalIconPath, themeCssVariables } from "@rikuy/core";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

import { platformSettings } from "@/server/platform";
import { portalView } from "@/server/portal-view";

import { InstallButton } from "./install-button";
import { SocialLinks } from "./social-links";

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
    robots: { index: true, follow: true },
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

  const { presentation, palette } = view.resolved;
  const { identity, contact, social } = presentation;
  const hasContact = Boolean(contact.email || contact.phone || contact.address);

  return (
    <div
      className="portal"
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
    </div>
  );
}
