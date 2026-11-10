import { describe, expect, it, vi } from "vitest";

import type { MembershipRole } from "../../contracts/organization";
import {
  deleteTour,
  loadTourRemoval,
  moveTour,
  tourPagesOf,
  type TourRemovalImpact,
} from "./removal";

const member = (role: MembershipRole) => ({
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "t",
  displayName: "T",
  role,
  tenantStatus: "active" as const,
});
const TOUR = "70000000-0000-4000-8000-000000000001";
const MUSEO = "71000000-0000-4000-8000-000000000001";
const PLAZA = "71000000-0000-4000-8000-000000000002";
const MIRADOR = "71000000-0000-4000-8000-000000000003";

const impact: TourRemovalImpact = {
  contentId: MUSEO,
  revisions: 2,
  published: true,
  inGeneralTour: true,
  startsGeneralTour: false,
  linkedFrom: [
    {
      tourId: "70000000-0000-4000-8000-000000000002",
      contentKind: "destination",
      contentTitle: "Plaza",
      draft: false,
      published: true,
    },
  ],
};

function deps() {
  return {
    removal: { removalImpact: vi.fn(async () => impact) },
    tours: {
      list: vi.fn(async () => [{ contentId: MUSEO }, { contentId: PLAZA }] as never[]),
    },
    candidates: vi.fn(async () => [
      { contentId: MUSEO, kind: "destination" as const, title: "Museo" },
      { contentId: PLAZA, kind: "destination" as const, title: "Plaza" },
      { contentId: MIRADOR, kind: "destination" as const, title: "Mirador" },
    ]),
  };
}

describe("deleting or moving a tour", () => {
  it("shows owners and admins what changes and where it can go: places without a tour", async () => {
    for (const role of ["owner", "admin"] as const) {
      expect(await loadTourRemoval(member(role), TOUR, deps())).toEqual({
        impact,
        destinations: [{ contentId: MIRADOR, kind: "destination", title: "Mirador" }],
        canRemove: true,
      });
    }
  });

  it("shows editors and analysts only what it is, without places to move it to", async () => {
    for (const role of ["editor", "analyst"] as const) {
      const d = deps();
      expect(await loadTourRemoval(member(role), TOUR, d)).toEqual({
        impact,
        destinations: [],
        canRemove: false,
      });
      expect(d.candidates).not.toHaveBeenCalled();
    }
  });

  it("knows nothing of an unknown tour", async () => {
    expect(await loadTourRemoval(member("owner"), "x", deps())).toBeNull();
    const d = deps();
    d.removal.removalImpact.mockResolvedValueOnce(null as never);
    expect(await loadTourRemoval(member("owner"), TOUR, d)).toBeNull();
  });

  it("lets only owners and admins delete, and asks the database", async () => {
    const removal = {
      deleteTour: vi.fn(async () => ({
        status: "deleted" as const,
        place: { kind: "destination" as const, slug: "museo" },
        formerPlaces: [],
      })),
    };
    for (const role of ["editor", "analyst"] as const) {
      expect(await deleteTour(member(role), TOUR, removal)).toEqual({ status: "forbidden" });
    }
    expect(await deleteTour(member("owner"), "not-an-id", removal)).toEqual({
      status: "not_found",
    });
    expect(removal.deleteTour).not.toHaveBeenCalled();
    expect(await deleteTour(member("admin"), TOUR, removal)).toEqual({
      status: "deleted",
      place: { kind: "destination", slug: "museo" },
      formerPlaces: [],
    });
    expect(removal.deleteTour).toHaveBeenCalledWith(member("admin").tenantId, TOUR);
  });

  it("lets only owners and admins move, and passes on what the database decides", async () => {
    const removal = { moveTour: vi.fn(async () => ({ status: "self_link" as const })) };
    expect(await moveTour(member("editor"), { tourId: TOUR, contentId: MIRADOR }, removal)).toEqual(
      { status: "forbidden" },
    );
    expect(await moveTour(member("owner"), { tourId: TOUR, contentId: 7 }, removal)).toEqual({
      status: "not_found",
    });
    expect(removal.moveTour).not.toHaveBeenCalled();
    expect(await moveTour(member("owner"), { tourId: TOUR, contentId: MIRADOR }, removal)).toEqual({
      status: "self_link",
    });
    expect(removal.moveTour).toHaveBeenCalledWith(member("owner").tenantId, TOUR, MIRADOR);
  });

  it("names the tour pages a delete or a move changes", () => {
    expect(
      tourPagesOf({ kind: "destination", slug: "museo" }, { kind: "event", slug: "feria" }),
    ).toEqual(["/destinos/museo/tour", "/agenda/feria/tour"]);
  });
});
