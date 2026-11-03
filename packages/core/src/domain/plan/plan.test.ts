import { describe, expect, it } from "vitest";

import { localClock, minutesFromDayStart, parseClockTime } from "./clock";
import {
  makePlan,
  orderPath,
  PLAN_RULES,
  type PlanDestination,
  type PlanEvent,
  type PlanInput,
} from "./engine";
import {
  describeOpenState,
  isOpenThrough,
  openingHoursLines,
  openingHoursText,
  openStateAt,
  type OpeningHours,
} from "./hours";
import { detectPlanIntent } from "./intent";

const TZ = "America/La_Paz"; // UTC−4, no daylight saving.
/** A Wednesday, at a local time. */
const at = (time: string, date = "2026-11-04") => new Date(`${date}T${time}:00-04:00`);

const weekdays: OpeningHours = {
  mode: "weekly",
  days: [
    [
      ["09:00", "12:30"],
      ["14:00", "18:00"],
    ],
    [["09:00", "18:00"]],
    [["09:00", "18:00"]],
    [["09:00", "18:00"]],
    [["09:00", "18:00"]],
    [["10:00", "24:00"]],
    [],
  ],
  note: "",
};

describe("the local clock", () => {
  it("reads the municipality's weekday, minutes and date", () => {
    expect(localClock(at("23:30"), TZ)).toEqual({
      weekday: 2,
      minutes: 23 * 60 + 30,
      date: "2026-11-04",
    });
    // 03:30 UTC on Thursday is still Wednesday in La Paz.
    expect(localClock(new Date("2026-11-05T03:30:00Z"), TZ).weekday).toBe(2);
    expect(localClock(at("00:00"), TZ).minutes).toBe(0);
  });

  it("measures an instant from today's local midnight", () => {
    const day = localClock(at("10:00"), TZ);
    expect(minutesFromDayStart(at("19:00"), day, TZ)).toBe(19 * 60);
    expect(minutesFromDayStart(at("01:00", "2026-11-05"), day, TZ)).toBe(25 * 60);
    expect(minutesFromDayStart(at("22:00", "2026-11-03"), day, TZ)).toBe(-2 * 60);
    expect(parseClockTime("24:00")).toBe(1440);
    expect(parseClockTime("9:00")).toBeNull();
  });
});

describe("opening hours", () => {
  const clock = (time: string, date?: string) => localClock(at(time, date), TZ);

  it("knows when a place is open, and when it opens again", () => {
    expect(openStateAt(weekdays, clock("10:00"))).toEqual({ state: "open", closesAt: 18 * 60 });
    // Monday has a lunch break.
    expect(openStateAt(weekdays, clock("13:00", "2026-11-02"))).toEqual({
      state: "closed",
      opens: { inDays: 0, weekday: 0, at: 14 * 60 },
    });
    expect(openStateAt(weekdays, clock("19:00"))).toEqual({
      state: "closed",
      opens: { inDays: 1, weekday: 3, at: 9 * 60 },
    });
    // Sunday is closed: opens on Monday.
    expect(openStateAt(weekdays, clock("11:00", "2026-11-08"))).toMatchObject({
      opens: { inDays: 1, weekday: 0 },
    });
    expect(openStateAt(null, clock("10:00"))).toEqual({ state: "unknown" });
    expect(openStateAt({ mode: "always", note: "" }, clock("03:00")).state).toBe("always");
  });

  it("needs the whole visit inside one range", () => {
    expect(isOpenThrough(weekdays, clock("10:00"), 17 * 60 + 20, 17 * 60 + 50)).toBe(true);
    expect(isOpenThrough(weekdays, clock("10:00"), 17 * 60 + 40, 18 * 60 + 10)).toBe(false);
    expect(isOpenThrough(null, clock("10:00"), 3 * 60, 4 * 60)).toBe(true);
  });

  it("says the week in words, days with the same hours together", () => {
    expect(openingHoursLines(weekdays)).toEqual([
      { days: "Lunes", times: "9:00–12:30 y 14:00–18:00" },
      { days: "Martes a viernes", times: "9:00–18:00" },
      { days: "Sábado", times: "10:00–24:00" },
      { days: "Domingo", times: "cerrado" },
    ]);
    expect(openingHoursText({ ...weekdays, note: "Cerrado los feriados" })).toBe(
      "Lunes: 9:00–12:30 y 14:00–18:00; martes a viernes: 9:00–18:00; sábado: 10:00–24:00; domingo: cerrado. Cerrado los feriados",
    );
    expect(openingHoursLines({ mode: "always", note: "" }, "en")).toEqual([
      { days: "Every day", times: "open 24 hours" },
    ]);
    expect(describeOpenState(openStateAt(weekdays, clock("10:00")))).toBe(
      "Abierto ahora · cierra a las 18:00",
    );
    expect(describeOpenState(openStateAt(weekdays, clock("19:00")))).toBe(
      "Cerrado ahora · abre mañana a las 9:00",
    );
    expect(describeOpenState(openStateAt(weekdays, clock("19:00", "2026-11-06")), "en")).toBe(
      "Closed now · opens tomorrow at 10:00",
    );
  });
});

describe("plan intents", () => {
  it("recognizes clear phrases only", () => {
    expect(detectPlanIntent("¿Qué hay cerca?")).toBe("nearby");
    expect(detectPlanIntent("What's near me?")).toBe("nearby");
    expect(detectPlanIntent("Dame un plan para hoy")).toBe("today");
    expect(detectPlanIntent("¿Qué puedo hacer hoy?")).toBe("today");
    expect(detectPlanIntent("What can I do today?")).toBe("today");
    expect(detectPlanIntent("¿Me sugieres una ruta?")).toBe("route");
    expect(detectPlanIntent("Suggested route please")).toBe("route");
    expect(detectPlanIntent("¿Qué hay en la plaza principal?")).toBeNull();
    expect(detectPlanIntent("¿Cómo llego en bus?")).toBeNull();
    expect(detectPlanIntent("¿Hay un recorrido 360?")).toBeNull();
  });
});

// ── The engine ─────────────────────────────────────────────────────────────

const point = (north: number, east: number) => ({
  lat: -17.39 + north / 111_000,
  lng: -66.15 + east / 106_000,
});

const plaza: PlanDestination = {
  slug: "plaza",
  title: "Plaza",
  location: point(0, 0),
  hours: null,
};
const museo: PlanDestination = {
  slug: "museo",
  title: "Museo",
  location: point(400, 0),
  hours: weekdays,
};
const mirador: PlanDestination = {
  slug: "mirador",
  title: "Mirador",
  location: point(1200, 300),
  hours: { mode: "always", note: "" },
};
const mercado: PlanDestination = {
  slug: "mercado",
  title: "Mercado",
  location: point(-300, 200),
  hours: {
    mode: "weekly",
    days: [[], [], [], [], [], [["06:00", "13:00"]], [["06:00", "13:00"]]],
    note: "",
  },
};
const feria: PlanEvent = {
  slug: "feria",
  title: "Feria",
  location: point(100, 100),
  startsAt: at("11:00").toISOString(),
  endsAt: at("15:00").toISOString(),
};
const pasado: PlanEvent = {
  slug: "pasado",
  title: "Ya terminó",
  location: point(10, 10),
  startsAt: at("07:00").toISOString(),
  endsAt: at("09:00").toISOString(),
};

const base = (overrides: Partial<PlanInput>): PlanInput => ({
  intent: "today",
  now: at("10:00"),
  timezone: TZ,
  destinations: [plaza, museo, mirador, mercado],
  events: [feria, pasado],
  origin: null,
  ...overrides,
});

const visitorAt = (where: { lat: number; lng: number }, input: PlanInput) => ({
  kind: "visitor" as const,
  distances: new Map(
    [
      ...input.destinations.map((d): [string, typeof d.location] => [
        `destination:${d.slug}`,
        d.location,
      ]),
      ...input.events.map((e): [string, typeof e.location] => [`event:${e.slug}`, e.location]),
    ]
      .filter((entry): entry is [string, { lat: number; lng: number }] => entry[1] !== null)
      .map(([key, location]) => {
        const dLat = (location.lat - where.lat) * 111_000;
        const dLng = (location.lng - where.lng) * 106_000;
        return [key, Math.round(Math.hypot(dLat, dLng) / 100) * 100] as const;
      }),
  ),
});

describe("«qué hay cerca»", () => {
  it("asks for a starting point first", () => {
    expect(makePlan(base({ intent: "nearby" })).outcome).toBe("needs_origin");
  });

  it("lists what is open or happening soon, nearest first, never what ended or is closed", () => {
    const input = base({ intent: "nearby" });
    const plan = makePlan({ ...input, origin: visitorAt(point(0, 0), input) });
    expect(plan.outcome).toBe("ok");
    expect(plan.stops.map((stop) => stop.key)).toEqual([
      "destination:plaza",
      "event:feria",
      "destination:museo",
      "destination:mirador",
    ]);
    // The market is closed on Wednesdays; the past event is over.
    expect(plan.stops.find((stop) => stop.slug === "mercado")).toBeUndefined();
    expect(plan.stops[1]?.status).toBe("upcoming");
    expect(plan.stops[0]?.status).toBe("unknown_hours");
    expect(plan.stops[2]?.closesAt).toBe(18 * 60);
  });

  it("from a place's page: the places around it, not itself", () => {
    const plan = makePlan(
      base({
        intent: "nearby",
        origin: { kind: "place", key: "destination:museo", point: point(400, 0) },
      }),
    );
    expect(plan.stops.map((stop) => stop.slug)).not.toContain("museo");
    expect(plan.stops[0]?.slug).toBe("feria");
  });

  it("from another city, says so", () => {
    const input = base({ intent: "nearby" });
    expect(makePlan({ ...input, origin: visitorAt(point(80_000, 0), input) }).outcome).toBe(
      "too_far",
    );
  });
});

describe("«plan para hoy»", () => {
  it("starts in the middle without a location, and fits the event in", () => {
    const plan = makePlan(base({}));
    expect(plan.origin).toBe("place");
    expect(plan.stops[0]?.legMeters).toBeNull();
    expect(plan.stops.map((stop) => stop.slug)).toContain("feria");
    expect(plan.stops.map((stop) => stop.slug)).not.toContain("pasado");
    expect(plan.stops.map((stop) => stop.slug)).not.toContain("mercado");
    // Times go forward, from now.
    let previous = 10 * 60;
    for (const stop of plan.stops) {
      expect(stop.arriveAt).toBeGreaterThanOrEqual(previous);
      expect(stop.leaveAt).toBeGreaterThanOrEqual(stop.arriveAt ?? 0);
      previous = stop.leaveAt ?? previous;
    }
  });

  it("never visits the museum after it closes", () => {
    const plan = makePlan(base({ now: at("17:40") }));
    expect(plan.stops.find((stop) => stop.slug === "museo")).toBeUndefined();
  });

  it("is over late in the evening", () => {
    expect(makePlan(base({ now: at("21:30") })).outcome).toBe("day_over");
  });
});

describe("«ruta sugerida»", () => {
  it("walks the open places in a short order", () => {
    const input = base({ intent: "route" });
    const plan = makePlan({ ...input, origin: visitorAt(point(0, 0), input) });
    expect(plan.stops.map((stop) => stop.slug)).toEqual(["plaza", "museo", "mirador"]);
    expect(plan.stops.every((stop) => stop.legMeters !== null)).toBe(true);
  });

  it("orders a path without crossings", () => {
    const places = [point(0, 0), point(0, 300), point(0, 100), point(0, 200)].map(
      (location, i) => ({
        location,
        i,
      }),
    );
    expect(orderPath(places, (p) => p.location.lng * 1000).map((p) => p.i)).toEqual([0, 2, 3, 1]);
  });
});

// ── The two rules, for any input ──────────────────────────────────────────

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

describe("for any input", () => {
  it("never recommends an event that ended nor a destination while it is closed", () => {
    const next = random(42);
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
    const time = () =>
      `${String(Math.floor(next() * 24)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}`;
    let checked = 0;
    for (let run = 0; run < 400; run += 1) {
      const destinations: PlanDestination[] = Array.from(
        { length: 1 + Math.floor(next() * 7) },
        (_, i) => {
          const open = Math.floor(next() * 20) * 60;
          const close = Math.min(1440, open + 60 + Math.floor(next() * 10) * 60);
          const range = [
            String(open / 60).padStart(2, "0") + ":00",
            close === 1440 ? "24:00" : `${String(close / 60).padStart(2, "0")}:00`,
          ] as const;
          const hours: OpeningHours | null = pick([
            null,
            { mode: "always", note: "" },
            {
              mode: "weekly",
              days: Array.from({ length: 7 }, () => (next() < 0.6 ? [range] : [])),
              note: "",
            },
          ]);
          return {
            slug: `d${i}`,
            title: `D${i}`,
            location: point(next() * 3000, next() * 3000),
            hours,
          };
        },
      );
      const events: PlanEvent[] = Array.from({ length: Math.floor(next() * 5) }, (_, i) => {
        const day = pick(["2026-11-03", "2026-11-04", "2026-11-05"]);
        const starts = at(time(), day);
        const ends = new Date(starts.getTime() + (1 + Math.floor(next() * 8)) * 3_600_000);
        return {
          slug: `e${i}`,
          title: `E${i}`,
          location: point(next() * 3000, next() * 3000),
          startsAt: starts.toISOString(),
          endsAt: ends.toISOString(),
        };
      });
      const now = at(time());
      const input: PlanInput = {
        intent: pick(["nearby", "today", "route"] as const),
        now,
        timezone: TZ,
        destinations,
        events,
        origin: null,
      };
      const plan = makePlan({
        ...input,
        origin: next() < 0.7 ? visitorAt(point(next() * 3000, next() * 3000), input) : null,
      });
      const clock = localClock(now, TZ);
      const keys = new Set<string>();
      for (const stop of plan.stops) {
        expect(keys.has(stop.key)).toBe(false);
        keys.add(stop.key);
        if (stop.kind === "event") {
          const event = events.find((e) => e.slug === stop.slug);
          expect(Date.parse(event?.endsAt ?? "")).toBeGreaterThan(now.getTime());
          if (stop.arriveAt !== null) {
            expect(stop.arriveAt).toBeLessThan(
              minutesFromDayStart(new Date(event?.endsAt ?? ""), clock, TZ),
            );
          }
        } else {
          const destination = destinations.find((d) => d.slug === stop.slug);
          const when = stop.arriveAt ?? clock.minutes;
          expect(
            openStateAt(destination?.hours ?? null, { ...clock, minutes: when }).state,
          ).not.toBe("closed");
        }
        checked += 1;
      }
      const limit =
        input.intent === "nearby"
          ? PLAN_RULES.nearbyStops
          : input.intent === "today"
            ? PLAN_RULES.todayStops
            : PLAN_RULES.routeStops;
      expect(plan.stops.length).toBeLessThanOrEqual(limit);
    }
    expect(checked).toBeGreaterThan(300);
  });
});
