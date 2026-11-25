import {
  directionsUrl,
  groupServices,
  openingHoursLines,
  PORTAL_PATHS,
  SERVICE_CATEGORY_INFO,
  telHref,
  whatsappHref,
  type PublishedService,
} from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalServices } from "@/server/portal-content";
import { portalHas, portalViewWith } from "@/server/portal-view";

import "../services.css";
import { ActionIcon } from "../action-icon";
import { OpenNow } from "../open-now";

interface ServicesPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: ServicesPageProps): Promise<Metadata> {
  const view = await portalViewWith((await params).host, "services");
  if (view === null) return {};
  const { siteName } = view.resolved.presentation.identity;
  const description = `Dónde comer, dormir, sacar dinero, cargar combustible y pedir ayuda en ${siteName}.`;
  return {
    title: "Servicios",
    description,
    alternates: { canonical: PORTAL_PATHS.services },
    openGraph: { title: `Servicios | ${siteName}`, description },
  };
}

/**
 * The municipality's local services (A · Paso 1.2, ADR-069): grouped by category, each
 * card with its anchor (the assistant's citations land on it), «Abierto ahora» computed in
 * the browser, and the call, WhatsApp and «Cómo llegar» buttons.
 */
export default async function ServicesPage({ params }: ServicesPageProps) {
  const view = await portalViewWith((await params).host, "services");
  if (view === null) notFound();
  const services = await portalServices(view);
  const groups = groupServices(services);
  const { siteName } = view.resolved.presentation.identity;
  const withMap = portalHas(view, "map");
  const { timezone } = view.context.tenant;

  return (
    <div className="portal-page services-page">
      <header className="listing-head">
        <h1 className="portal-page-title">Servicios</h1>
        <p className="portal-lead">
          Lo que necesitas durante tu visita a {siteName}: dónde comer, dormir, sacar dinero,
          moverte y pedir ayuda.
        </p>
      </header>
      {groups.length === 0 ? (
        <p className="portal-empty">Pronto publicaremos aquí los servicios del municipio.</p>
      ) : (
        <>
          {groups.length > 1 ? (
            <nav className="services-jump" aria-label="Categorías de servicios">
              <ul>
                {groups.map((group) => (
                  <li key={group.category}>
                    <a href={`#categoria-${group.category}`}>
                      {group.section} <span aria-hidden="true">({group.items.length})</span>
                      <span className="visually-hidden">: {group.items.length}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          {groups.map((group) => (
            <section
              key={group.category}
              id={`categoria-${group.category}`}
              className="services-group"
              aria-labelledby={`titulo-${group.category}`}
            >
              <h2 id={`titulo-${group.category}`}>{group.section}</h2>
              <ul className="services-list">
                {group.items.map((service) => (
                  <li key={service.slug}>
                    <ServiceCard service={service} timezone={timezone} withMap={withMap} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function ServiceCard({
  service,
  timezone,
  withMap,
}: {
  readonly service: PublishedService;
  readonly timezone: string;
  readonly withMap: boolean;
}) {
  const headingId = `servicio-${service.slug}`;
  return (
    <article id={service.slug} className="service-card" aria-labelledby={headingId}>
      <p className="service-category" data-category={service.category}>
        {SERVICE_CATEGORY_INFO[service.category].name}
      </p>
      <h3 id={headingId}>{service.title}</h3>
      {service.summary ? <p className="service-summary">{service.summary}</p> : null}
      {service.hours ? (
        <div className="service-hours">
          <OpenNow hours={service.hours} timezone={timezone} />
          <details>
            <summary>Ver el horario</summary>
            <dl className="portal-hours-week">
              {openingHoursLines(service.hours).map((line) => (
                <div key={line.days}>
                  <dt>{line.days}</dt>
                  <dd>{line.times}</dd>
                </div>
              ))}
            </dl>
            {service.hours.note ? <p className="portal-hours-note">{service.hours.note}</p> : null}
          </details>
        </div>
      ) : (
        <p className="service-no-hours">Sin horario publicado: confírmalo antes de ir.</p>
      )}
      {service.address ? <p className="service-address">{service.address}</p> : null}
      <div className="service-actions">
        {service.phone ? (
          <a className="portal-button" href={telHref(service.phone)}>
            <ActionIcon name="phone" />
            Llamar<span className="visually-hidden"> a {service.title}</span>
          </a>
        ) : null}
        {service.whatsapp ? (
          <a
            className="portal-button"
            href={whatsappHref(service.whatsapp)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ActionIcon name="message" />
            WhatsApp<span className="visually-hidden"> de {service.title} (abre WhatsApp)</span>
          </a>
        ) : null}
        {service.location ? (
          <a
            className="portal-button"
            href={directionsUrl(service.location)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ActionIcon name="directions" />
            Cómo llegar
            <span className="visually-hidden"> a {service.title} (abre la app de mapas)</span>
          </a>
        ) : null}
      </div>
      {service.location && withMap ? (
        <p className="service-map-link">
          <a
            href={`${PORTAL_PATHS.map}?lat=${service.location.lat}&lng=${service.location.lng}&servicios=1`}
          >
            Ver en el mapa del municipio
          </a>
        </p>
      ) : null}
    </article>
  );
}
