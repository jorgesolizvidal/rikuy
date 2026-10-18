/**
 * Portal map reads against a REAL local Supabase stack (seed data): places by area with
 * layers, never another municipality's, and the overall extent.
 */
import { describe, expect, it } from "vitest";

import { createSupabasePublishedMapReader } from "./content";
import { env, stackAvailable } from "./integration/local-stack";

const NORTE = "5eed1000-0000-4000-8000-000000000001";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const BOLIVIA = { west: -70, south: -23, east: -57, north: -9 };

describe.runIf(stackAvailable)("map reads against local Supabase", () => {
  const visitors = () =>
    createSupabasePublishedMapReader({ url: env.url, publishableKey: env.publishableKey });

  it("returns each municipality's own places inside the area, by layer", async () => {
    const norte = await visitors().places(NORTE, BOLIVIA, ["destination", "event"]);
    const slugs = norte.map((place) => `${place.kind}:${place.slug}`);
    expect(slugs).toContain("destination:mirador-del-valle");
    expect(slugs).toContain("event:feria-del-choclo");
    expect(slugs).not.toContain("event:festival-de-invierno"); // ended
    expect(slugs).not.toContain("destination:laguna-espejo"); // Demo Sur

    const onlyEvents = await visitors().places(NORTE, BOLIVIA, ["event"]);
    expect(onlyEvents.every((place) => place.kind === "event")).toBe(true);

    const sur = await visitors().places(SUR, BOLIVIA, ["destination"]);
    expect(sur.map((place) => place.slug)).toContain("laguna-espejo");

    const elsewhere = await visitors().places(NORTE, { west: 10, south: 10, east: 11, north: 11 }, [
      "destination",
      "event",
    ]);
    expect(elsewhere).toEqual([]);
  });

  it("frames the extent of the published places", async () => {
    const extent = await visitors().extent(NORTE);
    expect(extent.destinations).toBeGreaterThanOrEqual(1);
    expect(extent.bounds?.south).toBeLessThanOrEqual(-17.3901); // Mirador del Valle
    expect(extent.bounds?.north).toBeGreaterThanOrEqual(-17.3901);
  });
});
