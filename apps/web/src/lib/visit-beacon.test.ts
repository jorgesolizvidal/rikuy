import { PORTAL_PATHS, QR_SCAN_QUERY } from "@rikuy/core";
import { describe, expect, it } from "vitest";

import { QR_PARAM, tourPagePath, VISIT_ENDPOINT } from "./visit-beacon";

describe("visit beacon", () => {
  it("uses the portal's endpoint and the QR mark of @rikuy/core", () => {
    expect(VISIT_ENDPOINT).toBe(PORTAL_PATHS.visit);
    expect(QR_PARAM).toBe(QR_SCAN_QUERY);
  });

  it("counts a scene on its tour's page", () => {
    expect(tourPagePath("destination_tour", "museo")).toBe(PORTAL_PATHS.destinationTour("museo"));
    expect(tourPagePath("event_tour", "feria")).toBe(PORTAL_PATHS.eventTour("feria"));
  });
});
