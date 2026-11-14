import { describe, expect, it } from "vitest";

import type { CopilotReviewRow, CopilotSnapshotRow } from "../../contracts/copilot";
import { reviewForModules, snapshotForModules } from "./modules";

const row = (patch: Partial<CopilotReviewRow>): CopilotReviewRow => ({
  kind: "destination",
  contentId: "c1",
  slug: "plaza",
  tourId: null,
  sceneId: null,
  title: "Plaza",
  sceneTitle: null,
  status: "published",
  issues: ["summary_short"],
  ...patch,
});

const item = (patch: Partial<CopilotSnapshotRow>): CopilotSnapshotRow => ({
  kind: "destination",
  contentId: "c1",
  slug: "plaza",
  title: "Plaza",
  summary: "",
  status: "published",
  schedule: null,
  ended: false,
  tour: { tourId: "t1", status: "published", scenes: 2 },
  ...patch,
});

describe("the Copilot without some modules (ADR-060)", () => {
  const review = [
    row({}),
    row({ contentId: "c2", issues: ["tour_missing"] }),
    row({ contentId: "c3", issues: ["tour_missing", "cover_missing"] }),
    row({
      tourId: "t1",
      sceneId: "s1",
      sceneTitle: "Entrada",
      issues: ["scene_description_missing"],
    }),
    row({ kind: "event", contentId: "e1", slug: "feria", issues: ["schedule_missing"] }),
  ];

  it("reviews everything when the modules are unknown or all there", () => {
    expect(reviewForModules(review, undefined)).toEqual(review);
  });

  it("does not ask for tours without the tours, nor for events without the agenda", () => {
    expect(reviewForModules(review, ["map"])).toEqual([
      row({}),
      row({ contentId: "c3", issues: ["cover_missing"] }),
    ]);
    expect(reviewForModules(review, ["tours"]).map((r) => r.contentId)).toEqual([
      "c1",
      "c2",
      "c3",
      "c1",
    ]);
  });

  it("reads no events without the agenda and no tours without the tours", () => {
    const snapshot = [item({}), item({ kind: "event", contentId: "e1", tour: null })];
    expect(snapshotForModules(snapshot, ["agenda"])).toEqual([
      item({ tour: null }),
      item({ kind: "event", contentId: "e1", tour: null }),
    ]);
    expect(snapshotForModules(snapshot, ["tours"])).toEqual([item({})]);
  });
});
