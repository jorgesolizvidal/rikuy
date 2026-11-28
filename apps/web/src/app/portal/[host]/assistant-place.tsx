"use client";

import type { AssistantPlan, PublicCitation } from "@rikuy/core/assistant-client";

import { usePassport } from "@/lib/passport-store";

import { ASSISTANT_CARD_SIZES, type AssistantPlaceCard } from "./assistant-cards";
import { targetOf, useLinkProps } from "./assistant-links";
import { LocationButton } from "./visitor-location";

/**
 * The places an answer names, as cards (C3 · Paso 6, ADR-065): a cited destination or event
 * with its cover, category and real badges, and a plan with its summary and its stops. The
 * cards come from the portal's server (what is published); whether this phone already has a
 * place's stamp is read here (ADR-057).
 */

type Lang = "es" | "en";

const WORDS = {
  es: {
    destination: "Destino",
    event: "Evento",
    service: "Para comer",
    pause: "Pausa",
    kids: "Apto para niños",
    ends: "Termina",
    tour: "Recorrido 360°",
    stamp: "Sello del pasaporte",
    stamped: "Sellado en tu pasaporte",
    sources: "Fuentes",
    ended: "ya terminó",
    stops: "Paradas",
    distance: "Recorrido",
    walk: "A pie",
    stamps: "Sellos",
    have: (n: number) => `ya tienes ${n}`,
    estimate: "Distancias en línea recta y tiempos a pie estimados.",
    route: "Ver la ruta en el mapa",
    nearby: "Verlos en el mapa",
    location: "Usar mi ubicación",
  },
  en: {
    destination: "Place",
    event: "Event",
    service: "To eat",
    pause: "Break",
    kids: "Suitable for kids",
    ends: "Ends",
    tour: "360° tour",
    stamp: "Passport stamp",
    stamped: "In your passport",
    sources: "Sources",
    ended: "ended",
    stops: "Stops",
    distance: "Route",
    walk: "Walking",
    stamps: "Stamps",
    have: (n: number) => `you have ${n}`,
    estimate: "Straight-line distances and estimated walking times.",
    route: "See the route on the map",
    nearby: "See them on the map",
    location: "Use my location",
  },
} as const;

function byHref(cards: readonly AssistantPlaceCard[] | undefined) {
  return new Map((cards ?? []).map((card) => [card.href, card]));
}

function useStamps() {
  const passport = usePassport();
  return (card: AssistantPlaceCard | undefined) =>
    card?.stampPlaceId ? passport?.stamps[card.stampPlaceId] !== undefined : false;
}

function Badges({
  card,
  stamped,
  lang,
}: {
  readonly card: AssistantPlaceCard;
  readonly stamped: boolean;
  readonly lang: Lang;
}) {
  const words = WORDS[lang];
  if (!card.tour && !card.stampPlaceId) return null;
  return (
    <span className="assistant-badges">
      {card.tour ? <span className="assistant-badge">{words.tour}</span> : null}
      {card.stampPlaceId ? (
        <span className="assistant-badge" data-stamped={stamped ? "true" : undefined}>
          {stamped ? (
            <>
              <span aria-hidden="true">✓ </span>
              {words.stamped}
            </>
          ) : (
            words.stamp
          )}
        </span>
      ) : null}
    </span>
  );
}

function Thumb({ card, size }: { readonly card: AssistantPlaceCard; readonly size: string }) {
  return (
    <span className="assistant-card-media" aria-hidden="true">
      {card.image ? (
        // A versioned derivative from the portal's own address (ADR-050); the title is beside it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.image.src}
          srcSet={card.image.srcSet}
          sizes={size}
          width={card.image.width}
          height={card.image.height}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : (
        <PlaceIcon />
      )}
    </span>
  );
}

/** «Fuentes»: the cited places as cards, then any other source (documents, tours) in words. */
export function AnswerSources({
  sources,
  cards,
  lang,
}: {
  readonly sources: readonly PublicCitation[];
  readonly cards: readonly AssistantPlaceCard[] | undefined;
  readonly lang: Lang;
}) {
  const stampedOf = useStamps();
  const link = useLinkProps();
  if (sources.length === 0) return null;
  const words = WORDS[lang];
  const known = byHref(cards);
  const shown = new Set<string>();
  const placeCards: AssistantPlaceCard[] = [];
  const others: PublicCitation[] = [];
  for (const source of sources) {
    const card = source.href ? known.get(source.href) : undefined;
    if (card) {
      if (!shown.has(card.href)) placeCards.push(card);
      shown.add(card.href);
    } else others.push(source);
  }
  return (
    <div className="assistant-sources">
      <p className="assistant-sources-title">{words.sources}</p>
      {placeCards.length > 0 ? (
        <ul className="assistant-cards">
          {placeCards.map((card) => {
            const target = targetOf(card);
            const body = (
              <>
                <Thumb card={card} size="6rem" />
                <span className="assistant-card-body">
                  <span className="assistant-card-kicker">
                    {card.kind === "event" ? words.event : words.destination}
                    {card.category ? ` · ${card.category}` : ""}
                  </span>
                  <span className="assistant-card-title">{card.title}</span>
                  {card.date ? <span className="assistant-card-date">{card.date}</span> : null}
                  <Badges card={card} stamped={stampedOf(card)} lang={lang} />
                </span>
              </>
            );
            return (
              <li key={card.href}>
                {/* Without a page to open (no portal, no page on the website: ADR-071), the
                    card is shown all the same. */}
                {target ? (
                  <a className="assistant-card" {...link(target, card.href)}>
                    {body}
                  </a>
                ) : (
                  <div className="assistant-card">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {others.length > 0 ? (
        <ul className="assistant-source-list">
          {others.map((source) => {
            const text = `${source.title}${source.page ? ` · ${source.page}` : ""}${source.ended ? ` · ${words.ended}` : ""}`;
            const target = targetOf(source);
            return (
              <li key={`${source.href ?? ""}${source.title}${source.page ?? ""}`}>
                <span className="assistant-source-kind">{source.label}</span>{" "}
                {target ? <a {...link(target, source.href)}>{text}</a> : <span>{text}</span>}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A plan (ADR-039) as a card: for a plan for today or a route, its summary first (stops, the
 * walk in a straight line, the stamps it gives) with the route on the map; then every stop
 * with its photo, times and notes.
 */
export function PlanCard({
  plan,
  cards,
  lang,
}: {
  readonly plan: AssistantPlan;
  readonly cards: readonly AssistantPlaceCard[] | undefined;
  readonly lang: Lang;
}) {
  const stampedOf = useStamps();
  const link = useLinkProps();
  const words = WORDS[lang];
  if (plan.needsLocation) {
    return (
      <div className="assistant-plan">
        <LocationButton label={words.location} />
      </div>
    );
  }
  if (plan.stops.length === 0) return null;
  const known = byHref(cards);
  const stopCards = plan.stops.map((stop) => known.get(stop.href));
  const withStamp = stopCards.filter((card) => card?.stampPlaceId);
  const stampedCount = withStamp.filter((card) => stampedOf(card)).length;
  const cover = stopCards.find((card) => card?.image)?.image ?? null;
  const summary = plan.summary;
  const mapLink = plan.mapHref ? (
    <a className="assistant-plan-map" {...link(plan.mapHref)}>
      <RouteIcon />
      {plan.intent === "nearby" ? words.nearby : words.route}
    </a>
  ) : null;

  return (
    <section className="assistant-plan" data-intent={plan.intent} aria-label={plan.title}>
      <div className="assistant-plan-head" data-cover={cover ? "true" : undefined}>
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="assistant-plan-cover"
            src={cover.src}
            srcSet={cover.srcSet}
            sizes={ASSISTANT_CARD_SIZES}
            width={cover.width}
            height={cover.height}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <p className="assistant-plan-title">
          {plan.title}
          {plan.start ? <span className="assistant-plan-start">{plan.start}</span> : null}
        </p>
      </div>
      {summary ? (
        <dl className="assistant-plan-summary">
          <div>
            <dt>{words.stops}</dt>
            <dd>{summary.stops}</dd>
          </div>
          {summary.distance ? (
            <div>
              <dt>{words.distance}</dt>
              <dd>{summary.distance}</dd>
            </div>
          ) : null}
          {summary.walk ? (
            <div>
              <dt>{words.walk}</dt>
              <dd>~{summary.walk}</dd>
            </div>
          ) : null}
          {summary.endsAt ? (
            <div>
              <dt>{words.ends}</dt>
              <dd>{summary.endsAt}</dd>
            </div>
          ) : null}
          {withStamp.length > 0 ? (
            <div>
              <dt>{words.stamps}</dt>
              <dd>
                {withStamp.length}
                {stampedCount > 0 ? (
                  <span className="assistant-plan-have"> ({words.have(stampedCount)})</span>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {summary ? mapLink : null}
      <ol className="assistant-plan-stops">
        {plan.stops.map((stop, index) => {
          const card = stopCards[index];
          return (
            <li
              key={stop.href || `${stop.kind}-${stop.position}`}
              className="assistant-plan-stop"
              data-kind={stop.kind}
            >
              <span className="assistant-plan-number" aria-hidden="true">
                {stop.position}
              </span>
              {card ? <Thumb card={card} size="4rem" /> : null}
              <span className="assistant-plan-body">
                {targetOf(stop) ? (
                  <a {...link(targetOf(stop) ?? stop.href, stop.href)}>{stop.title}</a>
                ) : (
                  <span className="assistant-plan-name">{stop.title}</span>
                )}
                <span className="assistant-plan-kind">
                  {words[stop.kind]}
                  {card?.category ? ` · ${card.category}` : ""}
                </span>
                {stop.time ? <span className="assistant-plan-time">{stop.time}</span> : null}
                {stop.distance ? (
                  <span className="assistant-plan-distance">{stop.distance}</span>
                ) : null}
                {stop.note ? <span className="assistant-plan-note">{stop.note}</span> : null}
                {stop.kids ? <span className="assistant-plan-kids">{words.kids}</span> : null}
                {card ? <Badges card={card} stamped={stampedOf(card)} lang={lang} /> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="assistant-plan-hint">{words.estimate}</p>
      {summary ? null : mapLink}
    </section>
  );
}

function PlaceIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" focusable="false">
      <path
        fill="currentColor"
        d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"
      />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"
      />
    </svg>
  );
}
