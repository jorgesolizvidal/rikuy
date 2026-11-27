import { assistantPersona, helpDeskOf, monogram, PORTAL_PATHS } from "@rikuy/core";

import { aiGatewayStatus } from "@/server/ai-gateway";
import type { ResponsiveImage } from "@/server/portal-content";
import { portalHas, type PortalView } from "@/server/portal-view";

import { AssistantOnPage } from "./assistant-on-page";

export interface AskPlace {
  readonly kind: "destination" | "event";
  readonly title: string;
  /** The portal's page of the place, or its page on the municipality's website, if any. */
  readonly href: string | null;
  readonly linkLabel: string;
  readonly image: ResponsiveImage | null;
  /** The portal page the assistant is asked about (`/destinos/{dirección}`). */
  readonly pagePath: string;
}

/**
 * «Pregúntale a …» (ADR-071): the municipality's brand, the place its QR names (if any) and the
 * assistant open in the page. The same page for a municipality with or without its portal.
 */
export function AskShell({
  view,
  place,
}: {
  readonly view: PortalView;
  readonly place: AskPlace | null;
}) {
  const { presentation } = view.resolved;
  const { identity } = presentation;
  const persona = assistantPersona(presentation);
  const portal = portalHas(view, "portal");
  const available = aiGatewayStatus().configured;
  const title = persona.named ? `Pregúntale a ${persona.name}` : "Pregúntale al asistente";

  return (
    <>
      <header className="ask-header">
        <a href={portal ? "/" : PORTAL_PATHS.ask} className="ask-brand">
          {view.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="ask-logo"
              src={view.logo.webp}
              alt=""
              decoding="async"
              fetchPriority="low"
            />
          ) : (
            <span className="portal-mark" aria-hidden="true">
              {monogram(identity.shortName)}
            </span>
          )}
          <span className="ask-brand-name">{identity.siteName}</span>
        </a>
        {portal ? (
          <a className="ask-portal-link" href="/">
            Ver el portal
          </a>
        ) : null}
      </header>

      <main id="contenido" className="ask-main">
        <div className="ask-intro">
          <h1 className="ask-title">{title}</h1>
          {place ? (
            <div className="ask-place">
              {place.image ? (
                // A versioned derivative from the portal's own address (ADR-050).
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="ask-place-photo"
                  src={place.image.src}
                  srcSet={place.image.srcSet}
                  sizes="6rem"
                  width={place.image.width}
                  height={place.image.height}
                  alt=""
                  decoding="async"
                />
              ) : null}
              <p>
                <span className="ask-place-kind">
                  {place.kind === "event" ? "Evento" : "Lugar"}
                </span>
                <strong className="ask-place-title">{place.title}</strong>
                {place.href ? (
                  <a className="ask-place-link" href={place.href}>
                    {place.linkLabel}
                  </a>
                ) : null}
              </p>
            </div>
          ) : (
            <p className="ask-lead">
              Lugares, eventos, servicios e historia de {identity.siteName}, con lo que publica el
              municipio.
            </p>
          )}
        </div>

        {available ? (
          <AssistantOnPage
            name={persona.name}
            named={persona.named}
            greeting={persona.greeting}
            siteName={identity.siteName}
            logo={view.logo?.webp ?? null}
            mark={monogram(identity.shortName)}
            voice={portalHas(view, "voice")}
            helpDesk={helpDeskOf(view.resolved.presentation)}
            timezone={view.context.tenant.timezone}
            pagePath={place?.pagePath ?? null}
          />
        ) : (
          <p className="ask-unavailable" role="status">
            El asistente no está disponible por ahora. Vuelve a intentarlo más tarde.
          </p>
        )}
      </main>

      <footer className="ask-footer">
        <nav aria-label="Información legal">
          <a href={PORTAL_PATHS.privacy}>Privacidad</a>
          <a href={PORTAL_PATHS.terms}>Términos de uso</a>
        </nav>
        <p>Asistente oficial de {identity.siteName}. Funciona con Rikuy.</p>
      </footer>
    </>
  );
}
