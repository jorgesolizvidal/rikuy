import type { AnswerBlock } from "../../domain/assistant/answer";
import { answerBlocks, cleanAnswerText } from "../../domain/assistant/answer";
import type { AssistantLanguage } from "../../domain/assistant/language";
import type { AssistantPage } from "../../domain/assistant/page";
import type { AssistantPersona } from "../../domain/assistant/persona";
import { explainMessages } from "../../domain/assistant/prompts";
import type { AssistantRequest } from "../../domain/assistant/request";
import { formatDistance, formatMinutes } from "../../domain/geo/proximity";
import { formatClockTime, MINUTES_PER_DAY } from "../../domain/plan/clock";
import {
  makePlan,
  type PlanDestination,
  type PlanEvent,
  type PlanIntent,
  type PlanOrigin,
  type PlanResult,
  type PlanService,
  type PlanStop,
  type PlanVisit,
} from "../../domain/plan/engine";
import {
  estimateTokens,
  type AiCall,
  type AiSessionInput,
  type AiSessionResult,
} from "../ai/gateway";
import { portalSectionLinks } from "../ai/notices";
import { mapRoutePath, PORTAL_PATHS } from "../content/portal";
import type { PublishedDestinationReader, PublishedEventReader } from "../content/ports";
import type { PublishedServiceReader } from "../services/ports";

/**
 * «Qué hay cerca», «plan para hoy» (also by kind of visit, ADR-072) and «ruta sugerida» in
 * the assistant (ADR-039). The
 * engine decides every stop from the published data and the server's clock; the model only
 * writes two to four sentences about the result. Without the model (quota, provider down)
 * the visitor still gets the plan, with a fixed sentence.
 */

const EXPLAIN_OUTPUT = 400;

/**
 * What a plan may include: published destinations (with hours, visit time and «for
 * children»), upcoming events and the places to eat of a full day (ADR-072).
 */
export interface AssistantPlaces {
  readonly destinations: readonly PlanDestination[];
  readonly events: readonly PlanEvent[];
  readonly services?: readonly PlanService[];
}

/** A destination's or an event's visit time and «for children» (ADR-072). */
export interface PlanTraits {
  readonly visitMinutes: number | null;
  readonly kids: boolean | null;
}

/** Reads the visit time and «for children» of what is published, by `kind:slug`. */
export interface PlanTraitReader {
  planTraits(tenantId: string): Promise<ReadonlyMap<string, PlanTraits>>;
}

/**
 * The published destinations (with their hours), the upcoming events and, with the local
 * services, the places to eat, read together. A failure to read the visit times or the
 * services leaves a plan without them (45 minutes each, a pause for lunch), never without
 * a plan.
 */
export async function loadAssistantPlaces(
  tenantId: string,
  readers: {
    readonly destinations: PublishedDestinationReader;
    readonly events: PublishedEventReader;
    readonly traits?: PlanTraitReader;
    readonly services?: PublishedServiceReader;
  },
): Promise<AssistantPlaces> {
  const [destinations, hours, events, traits, services] = await Promise.all([
    readers.destinations.list(tenantId),
    readers.destinations.openingHours(tenantId),
    readers.events.list(tenantId),
    readers.traits
      ? readers.traits.planTraits(tenantId).catch(() => new Map<string, PlanTraits>())
      : new Map<string, PlanTraits>(),
    readers.services ? readers.services.list(tenantId).catch(() => []) : [],
  ]);
  return {
    destinations: destinations.map((destination) => {
      const trait = traits.get(`destination:${destination.slug}`);
      return {
        slug: destination.slug,
        title: destination.title,
        location: destination.location,
        hours: hours.get(destination.slug) ?? null,
        visitMinutes: trait?.visitMinutes ?? null,
        kids: trait?.kids ?? null,
      };
    }),
    events: events.map((event) => ({
      slug: event.slug,
      title: event.title,
      location: event.location,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      kids: traits.get(`event:${event.slug}`)?.kids ?? null,
    })),
    services: services
      .filter((service) => service.category === "food" && service.location !== null)
      .map((service) => ({
        slug: service.slug,
        title: service.title,
        location: service.location,
        hours: service.hours,
      })),
  };
}

export interface AssistantPlanStop {
  readonly position: number;
  /** `service`: lunch at a place to eat; `pause`: lunch without a place (ADR-072). */
  readonly kind: "destination" | "event" | "service" | "pause";
  readonly title: string;
  /** Empty for a pause, which leads nowhere (its `link` is null). */
  readonly href: string;
  /** Where it actually leads, when not `href` (ADR-071); null: no link. */
  readonly link?: string | null;
  /** «10:30–11:15» in a plan for today. */
  readonly time: string | null;
  /** «A 350 m · ~5 min a pie». */
  readonly distance: string | null;
  /** «Sin horario publicado: confírmalo», «Cierra a las 18:00», «Empieza a las 11:00». */
  readonly note: string | null;
  /** «Apto para niños», in a plan with children (ADR-072). */
  readonly kids?: boolean;
  /** The lunch of a full day (ADR-072). */
  readonly lunch?: boolean;
}

/**
 * A plan for today or a route at a glance (C3 · Paso 6, ADR-065): its stops, the walk between
 * them in a straight line and the estimated walking time. None for «qué hay cerca» (each
 * distance is from the visitor, not a route) or with a single stop.
 */
export interface AssistantPlanSummary {
  readonly stops: number;
  /** «1,2 km»: every leg of the plan, in a straight line; null when no leg is known. */
  readonly distance: string | null;
  /** «25 min»: the estimated walking time of those legs. */
  readonly walk: string | null;
  /** «17:30»: when a plan with a time (or the full day) ends (ADR-072). */
  readonly endsAt?: string;
}

export interface AssistantPlan {
  readonly intent: PlanIntent;
  /** The kind of visit of a plan for today (ADR-072). */
  readonly visit?: PlanVisit;
  readonly title: string;
  /** «Desde donde estás», «Desde «Plaza principal»». */
  readonly start: string | null;
  readonly stops: readonly AssistantPlanStop[];
  /** The route on the portal's map (numbered points joined by a straight line). */
  readonly mapHref: string | null;
  /** «Qué hay cerca» without the visitor's location: the panel offers to share it. */
  readonly needsLocation: boolean;
  readonly summary?: AssistantPlanSummary;
}

export interface PlanAnswer {
  readonly blocks: readonly AnswerBlock[];
  readonly plan: AssistantPlan;
  readonly links: readonly { readonly label: string; readonly href: string }[];
  /** The model explained it (false: the fixed sentence). */
  readonly explained: boolean;
  /** The stops as `kind:slug`, in order (for the evaluation). */
  readonly keys: readonly string[];
  readonly inputTokens: number;
  /** The gateway's request that explained it, when there was one (ADR-073: «pidió una persona»). */
  readonly requestId?: string;
  readonly outputTokens: number;
}

export interface PlanDeps {
  session<T>(
    input: AiSessionInput,
    work: (call: AiCall) => Promise<T>,
  ): Promise<AiSessionResult<T>>;
  places(tenantId: string): Promise<AssistantPlaces>;
  readonly now: () => Date;
}

export interface PlanTenant {
  readonly tenantId: string;
  readonly timezone: string;
  readonly siteName: string;
  readonly hasTours: boolean;
}

const WORDS = {
  es: {
    title: { nearby: "Qué hay cerca", today: "Plan para hoy", route: "Ruta sugerida" },
    visitTitle: (length: string, kids: boolean) => `${length}${kids ? " con niños" : ""}`,
    hours: (minutes: number) =>
      minutes === 60
        ? "Plan de 1 hora"
        : minutes === 240
          ? "Medio día"
          : minutes % 60 === 0
            ? `Plan de ${minutes / 60} horas`
            : `Plan de ${formatMinutes(minutes)}`,
    fullDay: "Día completo",
    lunchPause: "Pausa para almorzar",
    lunchNote: "Almuerzo",
    lunchPauseNote: "No hay lugares para comer publicados cerca: una hora libre",
    fromVisitor: "Desde donde estás",
    fromPlace: (title: string) => `Desde «${title}»`,
    fromCentre: (title: string) => `Desde «${title}», en el centro`,
    farStart: (title: string) => `Estás lejos de estos lugares: el plan empieza en «${title}»`,
    walk: (minutes: string) => `~${minutes} a pie`,
    at: (distance: string) => `A ${distance}`,
    here: "Estás aquí",
    nextDoor: "Al lado de la anterior",
    unknownHours: "Sin horario publicado: confírmalo antes de ir",
    closes: (time: string) => `Cierra a las ${time}`,
    ongoingUntil: (time: string) => `En curso hasta las ${time}`,
    ongoing: "En curso",
    starts: (time: string) => `Empieza a las ${time}`,
    fixed: {
      nearby: (n: number) =>
        n === 1
          ? "Esto es lo más cercano que está abierto ahora:"
          : `Estos son los ${n} lugares más cercanos que están abiertos o tienen algo ahora:`,
      today: (n: number) =>
        `Te propongo ${n} ${n === 1 ? "parada" : "paradas"} para hoy, con los horarios publicados y caminando entre ellas:`,
      visit: (n: number) =>
        `Te propongo ${n} ${n === 1 ? "parada" : "paradas"} que caben en tu tiempo, con los horarios publicados y caminando entre ellas:`,
      route: (n: number) =>
        `Una ruta a pie por ${n} ${n === 1 ? "lugar" : "lugares"}, en un orden corto:`,
    },
    needsLocation:
      "Para decirte qué hay cerca necesito saber desde dónde. Toca «Usar mi ubicación»: tu posición se queda en tu teléfono y solo se envían distancias redondeadas a los lugares.",
    nothing:
      "Ahora no encontré lugares abiertos ni eventos en curso con ubicación publicada. Mira la agenda y los destinos:",
    tooFar:
      "Estás a más de 15 km de los lugares de este portal, así que no hay nada cerca a pie. Mira los destinos o el mapa:",
    dayOver: "Ya es tarde para armar un plan de hoy. Mira la agenda para los próximos días:",
    tooShort:
      "En ese tiempo no alcanza para visitar ningún lugar abierto con los horarios publicados. Prueba con un plan más largo o mira la agenda y los destinos:",
  },
  en: {
    title: { nearby: "What's nearby", today: "Plan for today", route: "Suggested route" },
    visitTitle: (length: string, kids: boolean) => `${length}${kids ? " with kids" : ""}`,
    hours: (minutes: number) =>
      minutes === 60
        ? "1-hour plan"
        : minutes === 240
          ? "Half day"
          : minutes % 60 === 0
            ? `${minutes / 60}-hour plan`
            : `Plan of ${formatMinutes(minutes)}`,
    fullDay: "Full day",
    lunchPause: "Lunch break",
    lunchNote: "Lunch",
    lunchPauseNote: "No published places to eat nearby: a free hour",
    fromVisitor: "From where you are",
    fromPlace: (title: string) => `From «${title}»`,
    fromCentre: (title: string) => `From «${title}», in the centre`,
    farStart: (title: string) => `You are far from these places: the plan starts at «${title}»`,
    walk: (minutes: string) => `~${minutes} walk`,
    at: (distance: string) => distance,
    here: "You are here",
    nextDoor: "Next to the previous one",
    unknownHours: "No published opening hours: check before going",
    closes: (time: string) => `Closes at ${time}`,
    ongoingUntil: (time: string) => `On now until ${time}`,
    ongoing: "On now",
    starts: (time: string) => `Starts at ${time}`,
    fixed: {
      nearby: (n: number) =>
        n === 1
          ? "This is the closest place open now:"
          : `These are the ${n} closest places open or with something on now:`,
      today: (n: number) =>
        `Here is a plan with ${n} ${n === 1 ? "stop" : "stops"} for today, with the published hours and walking between them:`,
      visit: (n: number) =>
        `Here is a plan with ${n} ${n === 1 ? "stop" : "stops"} that fit your time, with the published hours and walking between them:`,
      route: (n: number) =>
        `A walking route through ${n} ${n === 1 ? "place" : "places"}, in a short order:`,
    },
    needsLocation:
      "To tell you what's nearby I need to know where you are. Tap «Use my location»: your position stays on your phone and only rounded distances to the places are sent.",
    nothing:
      "I found no places open or events on now with a published location. Have a look at the events and places:",
    tooFar:
      "You are more than 15 km from this portal's places, so nothing is within walking distance. Have a look at the places or the map:",
    dayOver: "It is too late for a plan for today. Have a look at the events of the coming days:",
    tooShort:
      "There is not enough time to visit any place open with the published hours. Try a longer plan or have a look at the events and places:",
  },
} as const;

/** «Plan de 2 horas con niños», «Día completo»; null without a kind of visit (ADR-072). */
export function visitTitle(lang: AssistantLanguage, visit: PlanVisit | null): string | null {
  if (!visit || (visit.length === null && !visit.kids)) return null;
  const words = WORDS[lang];
  const length =
    visit.length === null
      ? words.title.today
      : visit.length.kind === "full_day"
        ? words.fullDay
        : words.hours(visit.length.minutes);
  return words.visitTitle(length, visit.kids);
}

/** The page's place (a destination or an event, its tour included) as a plan key. */
export function pagePlaceKey(page: AssistantPage): string | null {
  if (page.slug === null) return null;
  if (page.kind === "destination" || page.kind === "destination_tour")
    return `destination:${page.slug}`;
  if (page.kind === "event" || page.kind === "event_tour") return `event:${page.slug}`;
  return null;
}

function pointOf(places: AssistantPlaces, key: string) {
  const [kind, slug] = key.split(":");
  const place =
    kind === "destination"
      ? places.destinations.find((d) => d.slug === slug)
      : places.events.find((e) => e.slug === slug);
  return place?.location ? { title: place.title, point: place.location } : null;
}

function clockText(minutes: number): string {
  return formatClockTime(((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY);
}

/** Closer than this, the distance is «aquí» (distances come rounded to 100 m). */
const HERE_METERS = 50;

function stopView(
  stop: PlanStop,
  index: number,
  intent: PlanIntent,
  lang: AssistantLanguage,
  fromVisitor: boolean,
  kids: boolean,
): AssistantPlanStop {
  const words = WORDS[lang];
  const time =
    intent === "today" && stop.arriveAt !== null && stop.leaveAt !== null
      ? `${clockText(stop.arriveAt)}–${clockText(stop.leaveAt)}`
      : null;
  // Lunch without a place to eat: a free hour where the visitor is (ADR-072).
  if (stop.kind === "pause") {
    return {
      position: index + 1,
      kind: "pause",
      title: words.lunchPause,
      href: "",
      link: null,
      time,
      distance: null,
      note: words.lunchPauseNote,
      lunch: true,
    };
  }
  const walk =
    stop.walkMinutes === null || stop.walkMinutes < 1
      ? null
      : words.walk(formatMinutes(stop.walkMinutes));
  const distance =
    stop.legMeters === null
      ? null
      : stop.legMeters < HERE_METERS
        ? fromVisitor && (intent === "nearby" || index === 0)
          ? words.here
          : words.nextDoor
        : [
            intent === "nearby"
              ? words.at(formatDistance(stop.legMeters))
              : formatDistance(stop.legMeters),
            walk,
          ]
            .filter((part): part is string => part !== null)
            .join(" · ");
  let note: string | null = null;
  if (stop.status === "unknown_hours") note = words.unknownHours;
  else if (stop.status === "open" && stop.closesAt !== null && stop.closesAt <= MINUTES_PER_DAY) {
    note = words.closes(clockText(stop.closesAt));
  } else if (stop.status === "upcoming" && stop.eventStart !== null) {
    note = words.starts(clockText(stop.eventStart));
  } else if (stop.status === "ongoing") {
    note =
      stop.eventEnd !== null && stop.eventEnd <= MINUTES_PER_DAY
        ? words.ongoingUntil(clockText(stop.eventEnd))
        : words.ongoing;
  }
  if (stop.kind === "service") {
    note = note === null ? words.lunchNote : `${words.lunchNote} · ${note}`;
  }
  return {
    position: index + 1,
    kind: stop.kind,
    title: stop.title,
    href:
      stop.kind === "destination"
        ? PORTAL_PATHS.destination(stop.slug)
        : stop.kind === "event"
          ? PORTAL_PATHS.event(stop.slug)
          : PORTAL_PATHS.service(stop.slug),
    time,
    distance,
    note,
    ...(kids && stop.kids === true ? { kids: true } : {}),
    ...(stop.kind === "service" ? { lunch: true } : {}),
  };
}

function planSummary(stops: readonly PlanStop[], endsAt: number | null): AssistantPlanSummary {
  const legs = stops.filter((stop) => stop.legMeters !== null);
  const meters = legs.reduce((total, stop) => total + (stop.legMeters ?? 0), 0);
  const minutes = legs.reduce((total, stop) => total + (stop.walkMinutes ?? 0), 0);
  // The places visited: the lunch is not a stop of the plan.
  const visits = stops.filter((stop) => stop.kind === "destination" || stop.kind === "event");
  return {
    stops: visits.length,
    distance: legs.length > 0 ? formatDistance(meters) : null,
    walk: legs.length > 0 && minutes >= 1 ? formatMinutes(minutes) : null,
    ...(endsAt !== null ? { endsAt: clockText(endsAt) } : {}),
  };
}

/** One line per stop for the model, in Spanish (it is data, like the passages). */
function modelLine(stop: AssistantPlanStop, view: PlanStop): string {
  if (stop.kind === "pause") {
    return ["Pausa para almorzar (sin lugar para comer publicado cerca)", stop.time ?? ""]
      .filter((part) => part !== "")
      .join(" · ");
  }
  const parts: string[] = [
    stop.title,
    stop.kind === "event" ? "evento" : stop.kind === "service" ? "almuerzo" : "destino",
  ];
  if (stop.kids) parts.push("apto para niños");
  if (stop.time) parts.push(stop.time);
  // No distances: from the visitor they would tell the provider roughly where they are.
  if (view.status === "unknown_hours") parts.push("confirmar el horario");
  else if (stop.note) parts.push(stop.note);
  return parts.join(" · ");
}

export interface PlanQuestion {
  readonly request: AssistantRequest;
  readonly intent: PlanIntent;
  /** The kind of visit of a plan for today (ADR-072). */
  readonly visit?: PlanVisit | null;
  readonly lang: AssistantLanguage;
  readonly persona: AssistantPersona;
  readonly today: string;
  readonly visitor: string | null;
}

/** Runs the engine (and, with stops, one short call to the model). */
export async function answerPlan(
  tenant: PlanTenant,
  question: PlanQuestion,
  deps: PlanDeps,
): Promise<PlanAnswer> {
  const { request, intent, lang } = question;
  const words = WORDS[lang];
  const places = await deps.places(tenant.tenantId);
  const now = deps.now();

  // The visitor's distances only for places that exist; the page's place otherwise.
  const known = new Set([
    ...places.destinations.map((d) => `destination:${d.slug}`),
    ...places.events.map((e) => `event:${e.slug}`),
    ...(places.services ?? []).map((s) => `service:${s.slug}`),
  ]);
  const distances = new Map([...request.distances].filter(([key]) => known.has(key)));
  const pageKey = pagePlaceKey(request.page);
  const pagePlace = pageKey ? pointOf(places, pageKey) : null;
  let origin: PlanOrigin | null =
    distances.size > 0
      ? { kind: "visitor", distances }
      : pageKey && pagePlace
        ? { kind: "place", key: pageKey, point: pagePlace.point }
        : null;

  const visit = intent === "today" ? (question.visit ?? null) : null;
  const input = { intent, now, timezone: tenant.timezone, ...places, origin, visit };
  let plan: PlanResult = makePlan(input);
  let farStart = false;
  // Far away (another city): a plan for today or a route starts in the middle instead.
  if (plan.outcome === "too_far" && intent !== "nearby") {
    origin = null;
    plan = makePlan({ ...input, origin });
    farStart = true;
  }

  const startTitle = plan.originKey ? (pointOf(places, plan.originKey)?.title ?? null) : null;
  const start =
    plan.origin === "visitor"
      ? words.fromVisitor
      : startTitle === null
        ? null
        : farStart
          ? words.farStart(startTitle)
          : plan.originKey === pageKey
            ? words.fromPlace(startTitle)
            : words.fromCentre(startTitle);
  const stops = plan.stops.map((stop, index) =>
    stopView(stop, index, intent, lang, plan.origin === "visitor", visit?.kids ?? false),
  );
  const title = visitTitle(lang, visit) ?? words.title[intent];
  const mapKeys = plan.stops.filter((stop) => stop.kind !== "pause").map((stop) => stop.key);
  const view: AssistantPlan = {
    intent,
    ...(visit ? { visit } : {}),
    title,
    start: stops.length > 0 ? start : null,
    stops,
    mapHref: mapKeys.length > 0 ? mapRoutePath(mapKeys) : null,
    needsLocation: plan.outcome === "needs_origin",
    ...(intent !== "nearby" && plan.stops.length > 1
      ? { summary: planSummary(plan.stops, plan.endsAt) }
      : {}),
  };

  const fixedReply = (text: string, withLinks: boolean): PlanAnswer => ({
    blocks: answerBlocks(text),
    plan: view,
    links: withLinks ? portalSectionLinks(lang, tenant.hasTours) : [],
    explained: false,
    keys: [],
    inputTokens: 0,
    outputTokens: 0,
  });
  if (plan.outcome === "needs_origin") return fixedReply(words.needsLocation, false);
  if (stops.length === 0) {
    return fixedReply(
      plan.outcome === "day_over"
        ? words.dayOver
        : plan.outcome === "too_far"
          ? words.tooFar
          : plan.outcome === "too_short"
            ? words.tooShort
            : words.nothing,
      true,
    );
  }

  const visits = plan.stops.filter((stop) => stop.kind === "destination" || stop.kind === "event");
  const fixed = visit?.length
    ? words.fixed.visit(visits.length)
    : words.fixed[intent](stops.length);
  const messages = explainMessages({
    persona: question.persona,
    lang,
    siteName: tenant.siteName,
    today: question.today,
    title,
    start: start ?? "",
    stops: stops.map((stop, index) => modelLine(stop, plan.stops[index] as PlanStop)),
    question: request.question,
  });
  const session = await deps.session(
    {
      tenantId: tenant.tenantId,
      profile: "assistant",
      reserveTokens: estimateTokens(messages) + EXPLAIN_OUTPUT,
      visitor: question.visitor,
    },
    async (call) => (await call({ messages, maxOutputTokens: EXPLAIN_OUTPUT })).text,
  );
  const text = session.outcome === "answered" ? cleanAnswerText(session.value).slice(0, 700) : "";
  // The list follows the text: one paragraph, and no time the plan does not have (a time
  // the model made up would contradict the list): then the fixed sentence instead.
  const allowed = new Set([
    ...stops.flatMap(
      (stop) => `${stop.time ?? ""} ${stop.note ?? ""}`.match(/\d{1,2}:\d{2}/gu) ?? [],
    ),
    ...(view.summary?.endsAt ? [view.summary.endsAt] : []),
  ]);
  const invented = (text.match(/\d{1,2}:\d{2}/gu) ?? []).some((time) => !allowed.has(time));
  const sentence = invented ? "" : text.replace(/\n+/gu, " ").trim();
  return {
    blocks: answerBlocks(sentence !== "" ? sentence : fixed),
    plan: view,
    links: [],
    explained: sentence !== "",
    keys: plan.stops.map((stop) => stop.key),
    inputTokens: session.outcome === "answered" ? session.usage.inputTokens : 0,
    outputTokens: session.outcome === "answered" ? session.usage.outputTokens : 0,
    ...(session.requestId ? { requestId: session.requestId } : {}),
  };
}
