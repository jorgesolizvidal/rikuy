import { describe, expect, it } from "vitest";

import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import {
  eventPublicationIssues,
  localTimeValue,
  validateEventDocument,
  type EventDocument,
} from "../../contracts/event";
import {
  dayAfter,
  eventDateBadge,
  formatEventMonth,
  formatEventSchedule,
  groupByMonth,
} from "../../domain/events/schedule";
import { loadAgenda, publishEvent, saveEventDraft } from "./events";
import type { ContentRepository, EventListEntry, PublishedEvent } from "./ports";
import { buildEventIcs, buildSitemap, eventJsonLd, PORTAL_PATHS } from "./portal";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const CONTENT = "5eed4100-0000-4000-8000-000000000011";
const VENUE = "5eed4100-0000-4000-8000-000000000001";

const member = (role: MembershipRole): OrganizationMembership => ({
  tenantId: TENANT,
  slug: "demo-norte",
  displayName: "Municipio Demo Norte",
  role,
  tenantStatus: "active",
});

const TIMED = { allDay: false, start: "2026-11-02T19:00", end: "2026-11-02T22:00" } as const;

const event: EventDocument = {
  title: "Feria del choclo",
  summary: "Productores del valle.",
  body: [],
  location: { lat: -17.39, lng: -66.15 },
  cover: null,
  gallery: [],
  schedule: TIMED,
  venueId: VENUE,
};

describe("event schedule", () => {
  it("accepts real local dates and times only", () => {
    expect(localTimeValue("2026-11-02T19:00", false)).toBe(Date.UTC(2026, 10, 2, 19, 0));
    expect(localTimeValue("2026-02-30", true)).toBeNull();
    expect(localTimeValue("2026-11-02T24:00", false)).toBeNull();
    expect(localTimeValue("2026-11-02", false)).toBeNull();
    expect(localTimeValue("2026-11-02T10:00", true)).toBeNull();
  });

  it("validates the document and tells the end before the start apart", () => {
    expect(validateEventDocument(event).ok).toBe(true);
    const backwards = validateEventDocument({
      ...event,
      schedule: { allDay: false, start: "2026-11-02T19:00", end: "2026-11-02T18:00" },
    });
    expect(backwards).toEqual({ ok: false, issues: [{ path: "schedule.end", code: "order" }] });
    const impossible = validateEventDocument({
      ...event,
      schedule: { allDay: true, start: "2026-02-30", end: "2026-03-01" },
    });
    expect(impossible).toEqual({
      ok: false,
      issues: [{ path: "schedule.start", code: "invalid" }],
    });
    expect(validateEventDocument({ ...event, venueId: "x" }).ok).toBe(false);
    const { venueId: _venue, ...withoutVenue } = event;
    expect(validateEventDocument(withoutVenue).ok).toBe(false);
  });

  it("needs a summary, a date and a place to be published", () => {
    expect(eventPublicationIssues(event)).toEqual([]);
    expect(
      eventPublicationIssues({ ...event, summary: "", schedule: null, location: null }),
    ).toEqual([
      { path: "summary", code: "required" },
      { path: "schedule", code: "required" },
      { path: "location", code: "required" },
    ]);
  });

  it("formats dates in Spanish without any time zone shift", () => {
    expect(formatEventSchedule(TIMED)).toBe("Lunes, 2 de noviembre de 2026, 19:00–22:00");
    expect(formatEventSchedule({ allDay: true, start: "2026-11-08", end: "2026-11-08" })).toBe(
      "Domingo, 8 de noviembre de 2026 (todo el día)",
    );
    expect(formatEventSchedule({ allDay: true, start: "2026-11-30", end: "2026-12-02" })).toBe(
      "30 de noviembre – 2 de diciembre de 2026",
    );
    expect(eventDateBadge(TIMED)).toEqual({ day: "2", month: "nov" });
    expect(formatEventMonth("2026-11")).toBe("Noviembre de 2026");
    expect(dayAfter("2026-12-31")).toBe("20270101");
  });

  it("groups events by the month they start in", () => {
    const items = [
      { id: 1, schedule: { allDay: true, start: "2026-11-30", end: "2026-12-02" } },
      { id: 2, schedule: { allDay: true, start: "2026-11-30", end: "2026-11-30" } },
      { id: 3, schedule: { allDay: false, start: "2026-12-05T10:00", end: "2026-12-05T11:00" } },
    ];
    expect(groupByMonth(items).map((g) => [g.monthKey, g.items.map((i) => i.id)])).toEqual([
      ["2026-11", [1, 2]],
      ["2026-12", [3]],
    ]);
  });
});

describe("event use cases", () => {
  function repository(overrides: Partial<ContentRepository> = {}) {
    const calls: string[] = [];
    const base = {
      listEvents: async () => [],
      async saveDraft(
        _t: string,
        _c: string,
        document: { title: string },
        expected: number | null,
      ) {
        calls.push(`save:${expected}:${document.title}`);
        return { status: "saved" as const, revisionNo: 1, editCount: (expected ?? 0) + 1 };
      },
      async publish(_t: string, _c: string, expected: number) {
        calls.push(`publish:${expected}`);
        return { status: "published" as const, revisionNo: 1 };
      },
      ...overrides,
    };
    return { repo: base as unknown as ContentRepository, calls };
  }

  it("editors save event drafts; only owners and admins publish them", async () => {
    const { repo, calls } = repository();
    expect(await saveEventDraft(member("editor"), CONTENT, event, 2, repo)).toEqual({
      status: "saved",
      revisionNo: 1,
      editCount: 3,
    });
    expect(
      await publishEvent(member("editor"), CONTENT, event, 3, repo, { publish: async () => {} }),
    ).toEqual({ status: "forbidden" });
    expect(await saveEventDraft(member("analyst"), CONTENT, event, 3, repo)).toEqual({
      status: "forbidden",
    });
    expect(
      await publishEvent(member("owner"), CONTENT, { ...event, schedule: null }, 3, repo, {
        publish: async () => {},
      }),
    ).toEqual({ status: "invalid", issues: [{ path: "schedule", code: "required" }] });
    expect(
      await publishEvent(member("admin"), CONTENT, event, 3, repo, { publish: async () => {} }),
    ).toEqual({ status: "published", revisionNo: 1 });
    expect(calls).toEqual(["save:2:Feria del choclo", "save:3:Feria del choclo", "publish:4"]);
  });

  it("explains a venue the database rejected", async () => {
    const { repo } = repository({
      saveDraft: async () => ({ status: "invalid", reason: "venue" }),
    });
    expect(await saveEventDraft(member("owner"), CONTENT, event, 1, repo)).toEqual({
      status: "invalid",
      issues: [{ path: "venueId", code: "invalid" }],
    });
  });

  it("splits the agenda into upcoming, undated and past", async () => {
    const entry = (slug: string, start: string | null, ended: boolean): EventListEntry => ({
      contentId: slug,
      slug,
      title: slug,
      status: "published",
      schedule: start ? { allDay: true, start, end: start } : null,
      ended,
      updatedAt: "2026-10-18T00:00:00Z",
      publishedAt: null,
    });
    const { repo } = repository({
      listEvents: async () => [
        entry("b", "2026-12-01", false),
        entry("old", "2026-01-01", true),
        entry("a", "2026-11-01", false),
        entry("older", "2025-01-01", true),
        entry("nodate", null, false),
      ],
    });
    const agenda = await loadAgenda(member("analyst"), repo);
    expect(agenda.upcoming.map((e) => e.slug)).toEqual(["a", "b"]);
    expect(agenda.undated.map((e) => e.slug)).toEqual(["nodate"]);
    expect(agenda.past.map((e) => e.slug)).toEqual(["old", "older"]);
  });
});

describe("event pages", () => {
  const published: PublishedEvent = {
    slug: "feria-del-choclo",
    revisionNo: 1,
    title: "Feria del choclo; música, comida",
    summary: "Productores del valle.",
    body: [],
    schedule: { allDay: false, start: "2026-11-02T19:00", end: "2026-11-02T22:00" },
    startsAt: "2026-11-02T23:00:00+00:00",
    endsAt: "2026-11-03T02:00:00+00:00",
    ended: false,
    location: { lat: -17.39, lng: -66.15 },
    cover: null,
    gallery: [],
    venue: { slug: "mirador-del-valle", title: "Mirador del Valle" },
    publishedAt: "2026-10-18T00:00:00Z",
    updatedAt: "2026-10-18T01:00:00Z",
  };

  it("builds an .ics with UTC instants for timed events and escaped text", () => {
    const ics = buildEventIcs(published, {
      url: "https://demo.example/agenda/feria-del-choclo",
      uid: "feria-del-choclo@demo.example",
      portalName: "Demo",
    });
    expect(ics).toContain("DTSTART:20261102T230000Z\r\n");
    expect(ics).toContain("DTEND:20261103T020000Z\r\n");
    expect(ics).toContain("SUMMARY:Feria del choclo\\; música\\, comida\r\n");
    expect(ics).toContain("LOCATION:Mirador del Valle\\, Demo\r\n");
    expect(ics).toContain("GEO:-17.39;-66.15\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it("uses dates for all-day events (end exclusive)", () => {
    const ics = buildEventIcs(
      { ...published, schedule: { allDay: true, start: "2026-11-30", end: "2026-12-01" } },
      { url: "https://x.test", uid: "x@x.test", portalName: "Demo" },
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20261130\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20261202\r\n");
  });

  it("folds long lines at 75 octets", () => {
    const ics = buildEventIcs(
      { ...published, summary: "ñ".repeat(120) },
      { url: "https://x.test", uid: "x@x.test", portalName: "Demo" },
    );
    expect(ics).toMatch(/\r\n ñ/u);
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it("describes the event for search engines", () => {
    const data = eventJsonLd(published, {
      url: "https://demo.example/agenda/feria-del-choclo",
      imageUrl: null,
      portalName: "Demo",
      portalUrl: "https://demo.example",
    });
    expect(data).toMatchObject({
      "@type": "Event",
      startDate: "2026-11-02T23:00:00+00:00",
      location: { "@type": "Place", name: "Mirador del Valle" },
    });
    const allDay = eventJsonLd(
      { ...published, schedule: { allDay: true, start: "2026-11-30", end: "2026-12-01" } },
      { url: "u", imageUrl: null, portalName: "Demo", portalUrl: "p" },
    );
    expect(allDay).toMatchObject({ startDate: "2026-11-30", endDate: "2026-12-01" });
  });

  it("adds the agenda and upcoming events to the sitemap", () => {
    const xml = buildSitemap("https://demo.example", [], [published]);
    expect(xml).toContain(`<loc>https://demo.example${PORTAL_PATHS.agenda}</loc>`);
    expect(xml).toContain("<loc>https://demo.example/agenda/feria-del-choclo</loc>");
  });
});
