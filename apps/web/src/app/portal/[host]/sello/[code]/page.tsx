import { isStampCode, nearbyRadiusOf, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { publishedStampReader } from "@/server/platform";
import { portalPassport, responsiveImage } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import "../../passport.css";
import { PassportHowItWorks } from "../../passport-how";
import { PortalImage } from "../../portal-image";
import { StampCollector } from "../../stamp-collector";

/**
 * What a stamp QR opens (ADR-057). Rendered per request (the code may have been renewed a
 * second ago), never indexed, and with no Referer: the code in the address is what stamps.
 */
export const dynamic = "force-dynamic";

interface StampPageProps {
  readonly params: Promise<{ host: string; code: string }>;
}

export const metadata: Metadata = {
  title: "Sello del pasaporte",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function StampPage({ params }: StampPageProps) {
  const { host, code } = await params;
  const view = await portalView(host);
  if (view === null) notFound();
  const tenantId = view.context.tenant.tenantId;
  const place = isStampCode(code) ? await publishedStampReader().place(tenantId, code) : null;

  const breadcrumb = (
    <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
      <ol>
        <li>
          <a href="/">Inicio</a>
        </li>
        <li>
          <a href={PORTAL_PATHS.passport}>Pasaporte turístico</a>
        </li>
        <li aria-current="page">Sello</li>
      </ol>
    </nav>
  );

  if (place === null) {
    return (
      <div className="portal-page">
        {breadcrumb}
        <h1 className="portal-page-title">Este código no sella</h1>
        <p className="portal-lead">
          Puede que el municipio lo haya renovado o que el lugar ya no sea parte de un circuito.
          Busca el código del pasaporte en el lugar, o mira los circuitos del pasaporte.
        </p>
        <p>
          <a href={PORTAL_PATHS.passport}>Ver el pasaporte turístico</a>
        </p>
      </div>
    );
  }

  const circuits = (await portalPassport(view))
    .filter((circuit) => circuit.stops.some((stop) => stop.id === place.id))
    .map((circuit) => ({
      slug: circuit.slug,
      href: PORTAL_PATHS.passportCircuit(circuit.slug),
      name: circuit.name,
      reward: circuit.reward,
      stopIds: circuit.stops.map((stop) => stop.id),
    }));

  return (
    <div className="portal-page stamp-page">
      {breadcrumb}
      <p className="stamp-kicker">Sello del pasaporte</p>
      <h1 className="portal-page-title">{place.title}</h1>
      {place.cover ? (
        <div className="stamp-cover">
          <PortalImage
            image={responsiveImage(tenantId, place.cover)}
            sizes="(min-width: 48rem) 40rem, 100vw"
            priority
          />
        </div>
      ) : null}
      <StampCollector
        code={code}
        placeId={place.id}
        title={place.title}
        location={place.location}
        radius={nearbyRadiusOf(view.resolved.presentation)}
        circuits={circuits}
        passportHref={PORTAL_PATHS.passport}
      />
      <p className="stamp-place-link">
        <a href={PORTAL_PATHS.destination(place.slug)}>Ver la ficha de «{place.title}»</a>
      </p>
      <PassportHowItWorks />
    </div>
  );
}
