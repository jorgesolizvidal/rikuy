import type { GeoPoint } from "../../contracts/destination";
import { distanceMeters, estimateTravel } from "../geo/proximity";
import { localClock, MINUTES_PER_DAY, minutesFromDayStart, type LocalClock } from "./clock";
import { closingAfter, isOpenThrough, openStateAt, type OpeningHours } from "./hours";

/**
 * «Qué hay cerca», «plan para hoy» and «ruta sugerida» (ADR-039). Deterministic: the engine
 * decides every stop and every time from the published data and the server's clock; the
 * model only explains the result in words. Two rules hold for every plan, whatever the
 * input: an event that already ended is never a stop, and a destination with published
 * hours is never a stop while it is closed.
 */

export type PlanIntent = "nearby" | "today" | "route";

export interface PlanDestination {
  readonly slug: string;
  readonly title: string;
  readonly location: GeoPoint | null;
  readonly hours: OpeningHours | null;
}

export interface PlanEvent {
  readonly slug: string;
  readonly title: string;
  readonly location: GeoPoint | null;
  /** Instants (ISO 8601), from the municipality's time zone. */
  readonly startsAt: string;
  readonly endsAt: string;
}

export type PlanPlaceKey = `destination:${string}` | `event:${string}`;

/**
 * Where the plan starts. `visitor`: straight-line distances the visitor's phone computed to
 * each place (the position itself never leaves the device). `place`: a place of the portal
 * (the page the visitor is on, or the one closest to the middle of the municipality).
 */
export type PlanOrigin =
  | { readonly kind: "visitor"; readonly distances: ReadonlyMap<string, number> }
  | { readonly kind: "place"; readonly key: string; readonly point: GeoPoint };

export interface PlanInput {
  readonly intent: PlanIntent;
  readonly now: Date;
  readonly timezone: string;
  readonly destinations: readonly PlanDestination[];
  readonly events: readonly PlanEvent[];
  readonly origin: PlanOrigin | null;
}

export type PlanStopStatus =
  /** A destination open now (or at the planned time), with the time it closes. */
  | "open"
  | "always"
  /** No published hours: «confirma el horario». */
  | "unknown_hours"
  | "ongoing"
  | "upcoming";

export interface PlanStop {
  readonly key: PlanPlaceKey;
  readonly kind: "destination" | "event";
  readonly slug: string;
  readonly title: string;
  readonly location: GeoPoint;
  readonly status: PlanStopStatus;
  /** Straight line from the previous stop (or the start); null for the start itself. */
  readonly legMeters: number | null;
  readonly walkMinutes: number | null;
  /** Local minutes from today's midnight (plans and routes); null for «qué hay cerca». */
  readonly arriveAt: number | null;
  readonly leaveAt: number | null;
  /** A destination's closing time, local minutes (when it has hours). */
  readonly closesAt: number | null;
  /** An event's local times today (minutes; negative or past 1440 when another day). */
  readonly eventStart: number | null;
  readonly eventEnd: number | null;
}

export type PlanOutcome =
  | "ok"
  /** «Qué hay cerca» without a starting point: the visitor shares their location first. */
  | "needs_origin"
  /** Nothing with a location is open or happening at that time. */
  | "nothing"
  /** The visitor is far from every place (another city): no walking plan from there. */
  | "too_far"
  /** Too late for a plan of today. */
  | "day_over";

export interface PlanResult {
  readonly intent: PlanIntent;
  readonly outcome: PlanOutcome;
  readonly origin: "visitor" | "place" | null;
  /** The key of the starting place when the plan starts at a place. */
  readonly originKey: string | null;
  readonly stops: readonly PlanStop[];
  /** Local clock of the moment the plan was made. */
  readonly clock: LocalClock;
}

export const PLAN_RULES = {
  nearbyStops: 5,
  todayStops: 5,
  routeStops: 6,
  /** «Qué hay cerca»: farther than this is not near. */
  nearbyMeters: 5_000,
  /** Beyond this the visitor is somewhere else (no walking plan from there). */
  farMeters: 15_000,
  /** The longest walk between two stops of a plan. */
  maxLegMeters: 5_000,
  /** An event starting within this is «cerca» now. */
  soonMinutes: 90,
  /** Time at a destination; a destination needs at least `minVisit` before it closes. */
  visitMinutes: 45,
  routeVisitMinutes: 30,
  minVisitMinutes: 30,
  /** Time at an event (or until it ends). */
  eventMinutes: 60,
  /** The longest wait for an event to start. */
  maxWaitMinutes: 90,
  /** An event needs at least this left when arriving. */
  minEventMinutes: 15,
  /** A plan of today ends here (local time). */
  dayEnd: 22 * 60,
  /** Asked later than this, there is no plan for today. */
  lastStart: 21 * 60,
} as const;

interface Candidate {
  readonly key: PlanPlaceKey;
  readonly kind: "destination" | "event";
  readonly slug: string;
  readonly title: string;
  readonly location: GeoPoint;
  readonly hours: OpeningHours | null;
  /** Events: local minutes from today's midnight. */
  readonly start: number;
  readonly end: number;
}

function candidates(input: PlanInput, clock: LocalClock): Candidate[] {
  const list: Candidate[] = [];
  for (const destination of input.destinations) {
    if (!destination.location) continue;
    list.push({
      key: `destination:${destination.slug}`,
      kind: "destination",
      slug: destination.slug,
      title: destination.title,
      location: destination.location,
      hours: destination.hours,
      start: Number.NEGATIVE_INFINITY,
      end: Number.POSITIVE_INFINITY,
    });
  }
  const nowMs = input.now.getTime();
  for (const event of input.events) {
    const starts = new Date(event.startsAt);
    const ends = new Date(event.endsAt);
    // Rule 1: an event that already ended (or whose dates cannot be read) is never a stop.
    if (!event.location || !(ends.getTime() > nowMs) || Number.isNaN(starts.getTime())) continue;
    list.push({
      key: `event:${event.slug}`,
      kind: "event",
      slug: event.slug,
      title: event.title,
      location: event.location,
      hours: null,
      start: minutesFromDayStart(starts, clock, input.timezone),
      end: minutesFromDayStart(ends, clock, input.timezone),
    });
  }
  return list;
}

/** Straight-line distance from the start to a candidate, or null when unknown. */
function fromOrigin(origin: PlanOrigin, candidate: Candidate): number | null {
  if (origin.kind === "place") return distanceMeters(origin.point, candidate.location);
  const meters = origin.distances.get(candidate.key);
  return meters !== undefined && Number.isFinite(meters) && meters >= 0 ? meters : null;
}

function walk(meters: number): number {
  const minutes = estimateTravel(meters).walkMinutes ?? Number.POSITIVE_INFINITY;
  // Plans round up to 5 minutes: nobody walks to the minute.
  return Math.ceil(minutes / 5) * 5;
}

interface Visit {
  readonly status: PlanStopStatus;
  readonly arrive: number;
  readonly start: number;
  readonly leave: number;
  readonly closesAt: number | null;
}

/** Whether (and how) a candidate can be visited when arriving at `arrive`; null when not. */
function visitAt(
  candidate: Candidate,
  arrive: number,
  clock: LocalClock,
  stay: number,
  dayEnd: number,
): Visit | null {
  if (candidate.kind === "event") {
    // Rule 1 again, at the planned time: an event over by then is not a stop.
    if (arrive > candidate.end - PLAN_RULES.minEventMinutes) return null;
    if (candidate.start - arrive > PLAN_RULES.maxWaitMinutes) return null;
    const start = Math.max(arrive, candidate.start);
    if (start >= dayEnd) return null;
    return {
      status: start <= arrive && candidate.start <= arrive ? "ongoing" : "upcoming",
      arrive,
      start,
      leave: Math.min(candidate.end, start + PLAN_RULES.eventMinutes),
      closesAt: null,
    };
  }
  if (arrive >= dayEnd) return null;
  // Rule 2: with published hours, it must be open on arrival and long enough to visit.
  if (!isOpenThrough(candidate.hours, clock, arrive, arrive + PLAN_RULES.minVisitMinutes)) {
    return null;
  }
  const closes = closingAfter(candidate.hours, clock, arrive);
  return {
    status:
      candidate.hours === null
        ? "unknown_hours"
        : candidate.hours.mode === "always"
          ? "always"
          : "open",
    arrive,
    start: arrive,
    leave: Math.min(arrive + stay, closes),
    closesAt: Number.isFinite(closes) ? closes : null,
  };
}

function stopOf(candidate: Candidate, legMeters: number | null, visit: Visit | null): PlanStop {
  return {
    key: candidate.key,
    kind: candidate.kind,
    slug: candidate.slug,
    title: candidate.title,
    location: candidate.location,
    status:
      visit?.status ??
      (candidate.kind === "event"
        ? "ongoing"
        : candidate.hours === null
          ? "unknown_hours"
          : candidate.hours.mode === "always"
            ? "always"
            : "open"),
    legMeters,
    walkMinutes: legMeters === null ? null : (estimateTravel(legMeters).walkMinutes ?? null),
    arriveAt: visit?.arrive ?? null,
    leaveAt: visit?.leave ?? null,
    closesAt: visit?.closesAt ?? null,
    eventStart: candidate.kind === "event" ? candidate.start : null,
    eventEnd: candidate.kind === "event" ? candidate.end : null,
  };
}

/** Where to start when the visitor gave no location: the place nearest the middle. */
export function centralPlace(list: readonly { key: string; location: GeoPoint }[]): {
  key: string;
  point: GeoPoint;
} | null {
  if (list.length === 0) return null;
  const middle = {
    lat: list.reduce((sum, place) => sum + place.location.lat, 0) / list.length,
    lng: list.reduce((sum, place) => sum + place.location.lng, 0) / list.length,
  };
  let best = list[0];
  for (const place of list) {
    if (best && distanceMeters(middle, place.location) < distanceMeters(middle, best.location)) {
      best = place;
    }
  }
  return best ? { key: best.key, point: best.location } : null;
}

function result(
  input: PlanInput,
  clock: LocalClock,
  outcome: PlanOutcome,
  stops: PlanStop[],
): PlanResult {
  return {
    intent: input.intent,
    outcome: outcome === "ok" && stops.length === 0 ? "nothing" : outcome,
    origin: input.origin?.kind ?? null,
    originKey: input.origin?.kind === "place" ? input.origin.key : null,
    stops,
    clock,
  };
}

function nearby(input: PlanInput, clock: LocalClock, all: Candidate[]): PlanResult {
  const origin = input.origin;
  if (!origin) return result(input, clock, "needs_origin", []);
  const now = clock.minutes;
  const ranked = all
    .filter((candidate) => origin.kind !== "place" || candidate.key !== origin.key)
    .map((candidate) => ({ candidate, meters: fromOrigin(origin, candidate) }))
    .filter((entry): entry is { candidate: Candidate; meters: number } => entry.meters !== null)
    .sort((a, b) => a.meters - b.meters);
  if (ranked.length > 0 && (ranked[0]?.meters ?? 0) > PLAN_RULES.farMeters) {
    return result(input, clock, "too_far", []);
  }
  const stops: PlanStop[] = [];
  for (const { candidate, meters } of ranked) {
    if (stops.length >= PLAN_RULES.nearbyStops || meters > PLAN_RULES.nearbyMeters) break;
    if (candidate.kind === "event") {
      // Happening now, or starting soon — never over.
      if (candidate.end <= now || candidate.start - now > PLAN_RULES.soonMinutes) continue;
      const visit = visitAt(
        candidate,
        now,
        clock,
        PLAN_RULES.eventMinutes,
        Number.POSITIVE_INFINITY,
      );
      if (!visit) continue;
      stops.push({ ...stopOf(candidate, meters, visit), arriveAt: null, leaveAt: null });
      continue;
    }
    const state = openStateAt(candidate.hours, clock);
    if (state.state === "closed") continue;
    stops.push({
      ...stopOf(candidate, meters, null),
      closesAt: state.state === "open" ? state.closesAt : null,
    });
  }
  return result(input, clock, "ok", stops);
}

/** Nearest neighbour from the start, then 2-opt on the open path (n ≤ 6: exact enough). */
export function orderPath<T extends { location: GeoPoint }>(
  places: readonly T[],
  first: (place: T) => number,
): T[] {
  const left = [...places];
  const order: T[] = [];
  while (left.length > 0) {
    const previous = order.at(-1);
    let bestIndex = 0;
    let bestMeters = Number.POSITIVE_INFINITY;
    left.forEach((place, index) => {
      const meters = previous ? distanceMeters(previous.location, place.location) : first(place);
      if (meters < bestMeters) {
        bestMeters = meters;
        bestIndex = index;
      }
    });
    order.push(...left.splice(bestIndex, 1));
  }
  const length = (path: T[]) =>
    path.reduce((total, place, index) => {
      const previous = path[index - 1];
      return total + (previous ? distanceMeters(previous.location, place.location) : first(place));
    }, 0);
  let improved = true;
  let best = order;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let k = i + 1; k < best.length; k += 1) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        if (length(candidate) + 1e-6 < length(best)) {
          best = candidate;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Walks the stops in order from `now`, keeping only those that can be visited when the
 * visitor gets there (rules 1 and 2), and computes each leg and time.
 */
function schedule(
  ordered: readonly Candidate[],
  origin: PlanOrigin,
  clock: LocalClock,
  stay: number,
  dayEnd: number,
  limit: number,
): PlanStop[] {
  const stops: PlanStop[] = [];
  let time = clock.minutes;
  let at: GeoPoint | null = null;
  for (const candidate of ordered) {
    if (stops.length >= limit) break;
    const isStart = stops.length === 0 && origin.kind === "place" && origin.key === candidate.key;
    const meters = isStart
      ? null
      : at
        ? distanceMeters(at, candidate.location)
        : fromOrigin(origin, candidate);
    if (!isStart && (meters === null || meters > PLAN_RULES.maxLegMeters)) continue;
    const arrive = time + (meters === null ? 0 : walk(meters));
    const visit = visitAt(candidate, arrive, clock, stay, dayEnd);
    if (!visit) continue;
    stops.push(stopOf(candidate, meters, visit));
    time = visit.leave;
    at = candidate.location;
  }
  return stops;
}

function startingPoint(input: PlanInput, all: Candidate[]): PlanOrigin | "too_far" | null {
  const origin = input.origin;
  if (origin?.kind === "visitor") {
    const nearest = Math.min(
      ...all.map((candidate) => fromOrigin(origin, candidate) ?? Number.POSITIVE_INFINITY),
    );
    if (nearest > PLAN_RULES.farMeters) return Number.isFinite(nearest) ? "too_far" : null;
    return origin;
  }
  if (origin) return origin;
  const destinations = all.filter((candidate) => candidate.kind === "destination");
  const centre = centralPlace(destinations.length > 0 ? destinations : all);
  return centre ? { kind: "place", key: centre.key, point: centre.point } : null;
}

function today(input: PlanInput, clock: LocalClock, all: Candidate[]): PlanResult {
  if (clock.minutes >= PLAN_RULES.lastStart) return result(input, clock, "day_over", []);
  const origin = startingPoint(input, all);
  if (origin === "too_far") return result(input, clock, "too_far", []);
  if (!origin) return result(input, clock, "nothing", []);
  const planInput = { ...input, origin };
  const dayEnd = Math.max(PLAN_RULES.dayEnd, clock.minutes + PLAN_RULES.minVisitMinutes);

  // Today's events only: the plan never waits for tomorrow.
  const left = all.filter(
    (candidate) => candidate.kind === "destination" || candidate.start < MINUTES_PER_DAY,
  );
  const stops: PlanStop[] = [];
  let time = clock.minutes;
  let at: GeoPoint | null = null;
  // The starting place, when it can be visited now, is the first stop.
  if (origin.kind === "place") {
    const start = left.find((candidate) => candidate.key === origin.key);
    const visit = start && visitAt(start, time, clock, PLAN_RULES.visitMinutes, dayEnd);
    if (start && visit) {
      stops.push(stopOf(start, null, visit));
      left.splice(left.indexOf(start), 1);
      time = visit.leave;
      at = start.location;
    } else {
      at = origin.point;
    }
  }
  while (stops.length < PLAN_RULES.todayStops) {
    let best: { candidate: Candidate; meters: number; visit: Visit; cost: number } | null = null;
    for (const candidate of left) {
      const meters = at ? distanceMeters(at, candidate.location) : fromOrigin(origin, candidate);
      if (meters === null || meters > PLAN_RULES.maxLegMeters) continue;
      const visit = visitAt(candidate, time + walk(meters), clock, PLAN_RULES.visitMinutes, dayEnd);
      if (!visit) continue;
      // Shortest walk plus waiting; an event is worth a little more walking (it happens once).
      const cost =
        walk(meters) + (visit.start - visit.arrive) - (candidate.kind === "event" ? 15 : 0);
      if (!best || cost < best.cost || (cost === best.cost && meters < best.meters)) {
        best = { candidate, meters, visit, cost };
      }
    }
    if (!best) break;
    stops.push(stopOf(best.candidate, best.meters, best.visit));
    left.splice(left.indexOf(best.candidate), 1);
    time = best.visit.leave;
    at = best.candidate.location;
  }
  return result(planInput, clock, "ok", stops);
}

function route(input: PlanInput, clock: LocalClock, all: Candidate[]): PlanResult {
  const origin = startingPoint(input, all);
  if (origin === "too_far") return result(input, clock, "too_far", []);
  if (!origin) return result(input, clock, "nothing", []);
  const planInput = { ...input, origin };
  const now = clock.minutes;
  // A walk now: destinations open now (or without hours) and events happening now.
  const open = all.filter((candidate) =>
    candidate.kind === "event"
      ? candidate.start <= now && candidate.end > now + PLAN_RULES.minEventMinutes
      : openStateAt(candidate.hours, clock).state !== "closed",
  );
  const first = (candidate: Candidate) =>
    origin.kind === "place" && candidate.key === origin.key
      ? -1
      : (fromOrigin(origin, candidate) ?? Number.POSITIVE_INFINITY);
  const nearest = open
    .filter((candidate) => Number.isFinite(first(candidate)))
    .sort((a, b) => first(a) - first(b))
    .slice(0, PLAN_RULES.routeStops);
  const ordered = orderPath(nearest, (candidate) => Math.max(0, first(candidate)));
  const startIndex = ordered.findIndex(
    (candidate) => origin.kind === "place" && candidate.key === origin.key,
  );
  if (startIndex > 0) ordered.unshift(...ordered.splice(startIndex, 1));
  const stops = schedule(
    ordered,
    origin,
    clock,
    PLAN_RULES.routeVisitMinutes,
    Number.POSITIVE_INFINITY,
    PLAN_RULES.routeStops,
  );
  return result(planInput, clock, "ok", stops);
}

export function makePlan(input: PlanInput): PlanResult {
  const clock = localClock(input.now, input.timezone);
  const all = candidates(input, clock);
  switch (input.intent) {
    case "nearby":
      return nearby(input, clock, all);
    case "today":
      return today(input, clock, all);
    case "route":
      return route(input, clock, all);
  }
}

/** For tests and the map: the total straight-line length of a plan. */
export function planLength(stops: readonly PlanStop[]): number {
  return stops.reduce((total, stop) => total + (stop.legMeters ?? 0), 0);
}
