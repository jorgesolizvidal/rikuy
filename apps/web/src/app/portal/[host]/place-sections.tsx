import {
  describeProximity,
  formatCoordinates,
  openStreetMapUrl,
  PORTAL_PATHS,
  type GeoPoint,
  type PublishedEventSummary,
} from "@rikuy/core";

import { responsiveImage, type NearbyPlaceDto } from "@/server/portal-content";

import { EventCard } from "./event-card";
import { MiniMap } from "./mini-map";
import { PortalImage } from "./portal-image";
import { DistanceText, LocationButton } from "./visitor-location";

/** Sections shared by a destination's and an event's page (C3 · Paso 4, ADR-063). */

/** «Ubicación»: the small map, the coordinates and where else to see the place. */
export function PlaceLocation({
  kind,
  title,
  location,
  withMap,
}: {
  readonly kind: "destination" | "event";
  readonly title: string;
  readonly location: GeoPoint;
  readonly withMap: boolean;
}) {
  return (
    <section aria-labelledby="ubicacion" className="portal-location">
      <h2 id="ubicacion">Ubicación</h2>
      {withMap ? (
        <MiniMap
          point={{
            key: "here",
            kind,
            title,
            href: "",
            detail: "",
            lat: location.lat,
            lng: location.lng,
          }}
        />
      ) : null}
      <p>
        {formatCoordinates(location)} ·{" "}
        {withMap ? (
          <>
            <a href={`${PORTAL_PATHS.map}?lat=${location.lat}&lng=${location.lng}`}>
              Ver en el mapa del municipio
            </a>{" "}
            ·{" "}
          </>
        ) : null}
        <a href={openStreetMapUrl(location)} target="_blank" rel="noopener noreferrer">
          OpenStreetMap
        </a>
      </p>
    </section>
  );
}

/** «A qué distancia estoy», in the visit card: computed on the device (ADR-021). */
export function VisitorDistance({ location }: { readonly location: GeoPoint }) {
  return (
    <div className="portal-visit-distance">
      <DistanceText point={location} />
      <LocationButton label="Ver a qué distancia estoy" />
    </div>
  );
}

/** «Eventos en este lugar»: the upcoming events at a destination, soonest first. */
export function EventsHere({ events }: { readonly events: readonly PublishedEventSummary[] }) {
  if (events.length === 0) return null;
  return (
    <section aria-labelledby="eventos-aqui" className="portal-detail-section">
      <h2 id="eventos-aqui">Eventos en este lugar</h2>
      <ul className="portal-events">
        {events.map((event) => (
          <EventCard key={event.slug} event={event} />
        ))}
      </ul>
      <p className="portal-detail-more">
        <a href={PORTAL_PATHS.agenda}>Ver toda la agenda</a>
      </p>
    </section>
  );
}

const THUMB_SIZES = "7rem";

/**
 * «Cerca de aquí»: the published places closest to this one, in a straight line from it (never
 * from the visitor, so the server knows it and the page is cached).
 */
export function NearbyPlaces({
  tenantId,
  title,
  places,
}: {
  readonly tenantId: string;
  readonly title: string;
  readonly places: readonly NearbyPlaceDto[];
}) {
  if (places.length === 0) return null;
  return (
    <section aria-labelledby="cerca-de-aqui" className="portal-close">
      <h2 id="cerca-de-aqui">Cerca de aquí</h2>
      <p className="portal-close-note">Distancias en línea recta desde {title}.</p>
      <ul>
        {places.map((place) => (
          <li key={place.key} data-kind={place.kind}>
            <a href={place.href}>
              <span className="portal-close-media">
                {place.cover ? (
                  <PortalImage
                    image={{ ...responsiveImage(tenantId, place.cover), alt: "" }}
                    sizes={THUMB_SIZES}
                  />
                ) : null}
              </span>
              <span className="portal-close-text">
                <span className="portal-map-kind">
                  {place.kind === "event" ? "Evento" : "Destino"}
                </span>
                <span className="portal-close-title">{place.title}</span>
                {place.detail ? <span className="portal-close-detail">{place.detail}</span> : null}
                <span className="portal-close-distance">
                  {describeProximity(place.meters).distance}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
