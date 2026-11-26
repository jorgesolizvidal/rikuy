import { describe, expect, it } from "vitest";

import { validateDestinationDocument, VISIT_MINUTES_CHOICES } from "./destination";
import { validateEventDocument } from "./event";

/** The visit time and «for children» of the editor's documents (ADR-072). */
describe("visit time and «for children»", () => {
  const destination = {
    title: "Museo",
    summary: "",
    body: [],
    location: null,
    cover: null,
    gallery: [],
  };

  it("a destination accepts both, optional, as the database does", () => {
    for (const minutes of VISIT_MINUTES_CHOICES) {
      expect(validateDestinationDocument({ ...destination, visitMinutes: minutes }).ok).toBe(true);
    }
    expect(validateDestinationDocument({ ...destination, visitMinutes: null, kids: null }).ok).toBe(
      true,
    );
    expect(validateDestinationDocument({ ...destination, kids: false }).ok).toBe(true);
    for (const minutes of [10, 245, 47, 45.5, "45"]) {
      expect(validateDestinationDocument({ ...destination, visitMinutes: minutes }).ok).toBe(false);
    }
    expect(validateDestinationDocument({ ...destination, kids: "si" }).ok).toBe(false);
  });

  it("an event has «for children», never a visit time", () => {
    const event = { ...destination, schedule: null, venueId: null };
    expect(validateEventDocument({ ...event, kids: true }).ok).toBe(true);
    expect(validateEventDocument({ ...event, visitMinutes: 60 }).ok).toBe(false);
  });
});
