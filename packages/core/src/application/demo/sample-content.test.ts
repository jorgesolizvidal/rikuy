import { describe, expect, it, vi } from "vitest";

import { isValidContentSlug, validateDestinationDocument } from "../../contracts/destination";
import { validateEventDocument } from "../../contracts/event";
import { parseMarkup } from "../../domain/content/markup";
import {
  fillSampleText,
  offsetPoint,
  SAMPLE_DESTINATIONS,
  SAMPLE_EVENTS,
  SAMPLE_TOUR_DESTINATION,
  sampleEventDate,
} from "../../domain/demo/sample-template";
import { buildSampleTour, loadSampleContent, loadSampleContentStatus } from "./sample-content";

const demoOwner = {
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "demo-valle",
  displayName: "Demo Valle",
  role: "owner" as const,
  tenantStatus: "active" as const,
  demo: true,
};
const center = { lat: -17.3901, lng: -66.1502 };

describe("sample template", () => {
  it("is valid content for any municipality, with no real one in it", () => {
    const slugs = [...SAMPLE_DESTINATIONS, ...SAMPLE_EVENTS].map((item) => item.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every(isValidContentSlug)).toBe(true);
    expect(SAMPLE_DESTINATIONS.some((item) => item.slug === SAMPLE_TOUR_DESTINATION)).toBe(true);

    for (const item of SAMPLE_DESTINATIONS) {
      const body = parseMarkup(fillSampleText(item.body, "Demo Valle"));
      expect(body.problems).toEqual([]);
      expect(body.blocks[0]?.type).toBe("paragraph");
      expect(JSON.stringify(body.blocks)).toContain("Texto de muestra");
      const validation = validateDestinationDocument({
        title: item.title,
        summary: fillSampleText(item.summary, "Demo Valle"),
        body: body.blocks,
        location: offsetPoint(center, item.offset.north, item.offset.east),
        cover: { assetId: demoOwner.tenantId, version: 1, alt: item.alt },
        gallery: [{ assetId: demoOwner.tenantId, version: 2, alt: item.galleryAlt }],
      });
      expect(validation.ok).toBe(true);
      expect(item.summary + item.body).not.toMatch(/\{(?!municipio\})/u);
    }
    for (const item of SAMPLE_EVENTS) {
      expect(SAMPLE_DESTINATIONS.map((place) => place.slug)).toContain(item.venue);
      const day = sampleEventDate(new Date("2026-10-27T12:00:00Z"), item.inDays, item.weekday);
      const validation = validateEventDocument({
        title: item.title,
        summary: item.summary,
        body: parseMarkup(item.body).blocks,
        location: center,
        cover: null,
        gallery: [],
        schedule: { allDay: false, start: `${day}T${item.start}`, end: `${day}T${item.end}` },
        venueId: null,
      });
      expect(validation.ok).toBe(true);
    }
  });

  it("places items around the center and dates events on their weekday, in the future", () => {
    const north = offsetPoint(center, 1000, 0);
    expect(north.lat - center.lat).toBeCloseTo(0.008983, 5);
    expect(north.lng).toBe(center.lng);
    const east = offsetPoint(center, 0, 1000);
    expect(east.lng - center.lng).toBeCloseTo(0.009418, 4);
    expect(offsetPoint({ lat: 0, lng: 179.999 }, 0, 1000).lng).toBeLessThan(-179);

    // Tuesday 27 October 2026 → Saturday 31 is the first Saturday 4 days later.
    expect(sampleEventDate(new Date("2026-10-27T23:00:00Z"), 4, 6)).toBe("2026-10-31");
    expect(sampleEventDate(new Date("2026-10-27T23:00:00Z"), 9, 0)).toBe("2026-11-08");
    expect(sampleEventDate(new Date("2026-10-31T10:00:00Z"), 4, 6)).toBe("2026-11-07");
  });
});

describe("sample content use cases", () => {
  function deps() {
    return {
      content: {
        listDestinations: vi.fn(async () => []),
        listEvents: vi.fn(async () => []),
      },
      tours: { list: vi.fn(async () => []) },
      panoramas: { list: vi.fn(async () => []) },
    };
  }

  it("is only for owners and admins of a demo, and needs a center", async () => {
    const d = deps();
    const any = d as never;
    const real = { ...demoOwner, demo: undefined };
    expect(await loadSampleContent(real, { center: "-17.39, -66.15" }, any)).toEqual({
      status: "not_demo",
    });
    expect(
      await loadSampleContent({ ...demoOwner, role: "editor" }, { center: "-17.39, -66.15" }, any),
    ).toEqual({ status: "forbidden" });
    expect(await loadSampleContent(demoOwner, { center: "la plaza" }, any)).toEqual({
      status: "invalid_center",
    });
    expect(await buildSampleTour(real, any)).toEqual({ status: "not_demo" });
    expect(await loadSampleContentStatus(real, d)).toBeNull();
    expect(d.content.listDestinations).not.toHaveBeenCalled();
  });

  it("tells where the demo stands", async () => {
    const d = deps();
    expect(await loadSampleContentStatus(demoOwner, d)).toEqual({
      loaded: false,
      partial: false,
      tour: "none",
    });
    const all = [...SAMPLE_DESTINATIONS, ...SAMPLE_EVENTS].map((item) => ({ slug: item.slug }));
    d.content.listDestinations.mockResolvedValue(all.slice(0, 5) as never);
    d.content.listEvents.mockResolvedValue(all.slice(5) as never);
    d.panoramas.list.mockResolvedValue([{ status: "processing" }, { status: "ready" }] as never);
    expect(await loadSampleContentStatus(demoOwner, d)).toEqual({
      loaded: true,
      partial: false,
      tour: "processing",
    });
    d.panoramas.list.mockResolvedValue([{ status: "ready" }, { status: "ready" }] as never);
    expect((await loadSampleContentStatus(demoOwner, d))?.tour).toBe("ready");
    d.panoramas.list.mockResolvedValue([] as never);
    expect((await loadSampleContentStatus(demoOwner, d))?.tour).toBe("missing");
    d.tours.list.mockResolvedValue([
      { contentKind: "destination", contentSlug: SAMPLE_TOUR_DESTINATION },
    ] as never);
    expect((await loadSampleContentStatus(demoOwner, d))?.tour).toBe("built");
    d.content.listEvents.mockResolvedValue([] as never);
    expect(await loadSampleContentStatus(demoOwner, d)).toMatchObject({
      loaded: false,
      partial: true,
    });
  });
});
