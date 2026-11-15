import { describe, expect, it } from "vitest";

import { describeCountdown, eventCountdown } from "./countdown";

const LA_PAZ = "America/La_Paz"; // UTC−4, no daylight saving.

const timed = {
  schedule: { allDay: false, start: "2026-11-20T19:00" },
  startsAt: "2026-11-20T23:00:00.000Z",
  endsAt: "2026-11-21T02:00:00.000Z",
};
const allDay = {
  schedule: { allDay: true, start: "2026-11-20" },
  startsAt: "2026-11-20T04:00:00.000Z",
  endsAt: "2026-11-22T04:00:00.000Z",
};
const say = (event: typeof timed, iso: string) =>
  describeCountdown(eventCountdown(event, new Date(iso), LA_PAZ));

describe("event countdown (C3 · Paso 4)", () => {
  it("today and tomorrow are the municipality's, with the local time", () => {
    expect(say(timed, "2026-11-20T12:00:00Z")).toBe("Hoy a las 19:00");
    // 23:30 in La Paz on the 19th is already the 20th in UTC: still «Mañana».
    expect(say(timed, "2026-11-20T03:30:00Z")).toBe("Mañana a las 19:00");
    expect(say(allDay, "2026-11-19T15:00:00Z")).toBe("Mañana");
  });

  it("in N days up to a month; later, the date says enough", () => {
    expect(say(timed, "2026-11-15T15:00:00Z")).toBe("En 5 días");
    expect(eventCountdown(timed, new Date("2026-11-15T15:00:00Z"), LA_PAZ)).toEqual({
      state: "soon",
      days: 5,
    });
    expect(say(timed, "2026-09-01T15:00:00Z")).toBeNull();
  });

  it("ongoing between its instants, ended after them", () => {
    expect(say(timed, "2026-11-20T23:30:00Z")).toBe("En curso");
    // An all-day event lasts its whole last day.
    expect(say(allDay, "2026-11-22T03:59:00Z")).toBe("En curso");
    expect(say(allDay, "2026-11-22T04:00:00Z")).toBe("Ya terminó");
    expect(say(timed, "2026-11-21T02:00:00Z")).toBe("Ya terminó");
  });

  it("an unknown time zone falls back to UTC instead of failing", () => {
    expect(
      describeCountdown(eventCountdown(allDay, new Date("2026-11-19T12:00:00Z"), "Nowhere/City")),
    ).toBe("Mañana");
  });
});
