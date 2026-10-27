import { describe, expect, it, vi } from "vitest";

import type { MembershipRole } from "../../contracts/organization";
import {
  generalTourDocumentSchema,
  loadGeneralTour,
  saveGeneralTour,
  type GeneralTourRepository,
} from "./general";

const member = (role: MembershipRole) => ({
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "t",
  displayName: "T",
  role,
  tenantStatus: "active" as const,
});
const A = "70000000-0000-4000-8000-000000000001";
const B = "70000000-0000-4000-8000-000000000002";

function repository(): Pick<GeneralTourRepository, "load" | "save"> & {
  save: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn(async () => ({ editCount: 2, startTourId: null, tours: [] })),
    save: vi.fn(async () => ({ status: "saved" as const, editCount: 3 })),
  };
}

describe("the general tour", () => {
  it("lets owners and administrators save the order and the start", async () => {
    for (const role of ["owner", "admin"] as const) {
      const general = repository();
      expect(
        await saveGeneralTour(
          member(role),
          { expectedEdit: 2, order: [B, A], startTourId: A },
          { general },
        ),
      ).toEqual({ status: "saved", editCount: 3 });
      expect(general.save).toHaveBeenCalledWith(member(role).tenantId, 2, [B, A], A);
    }
  });

  it("refuses editors and analysts before asking the database", async () => {
    for (const role of ["editor", "analyst"] as const) {
      const general = repository();
      expect(
        await saveGeneralTour(
          member(role),
          { expectedEdit: 2, order: [A], startTourId: null },
          { general },
        ),
      ).toEqual({ status: "forbidden" });
      expect(general.save).not.toHaveBeenCalled();
    }
  });

  it("refuses a tour twice, a bad id or a bad start", async () => {
    const general = repository();
    const owner = member("owner");
    expect(
      await saveGeneralTour(
        owner,
        { expectedEdit: 2, order: [A, A], startTourId: null },
        { general },
      ),
    ).toEqual({
      status: "invalid",
      reason: "order",
    });
    expect(
      await saveGeneralTour(
        owner,
        { expectedEdit: 2, order: ["x"], startTourId: null },
        { general },
      ),
    ).toEqual({
      status: "invalid",
      reason: "order",
    });
    expect(
      await saveGeneralTour(owner, { expectedEdit: 2, order: [], startTourId: "x" }, { general }),
    ).toEqual({
      status: "invalid",
      reason: "start",
    });
    expect(general.save).not.toHaveBeenCalled();
  });

  it("shows everyone the order; only owners and administrators may change it", async () => {
    expect((await loadGeneralTour(member("analyst"), { general: repository() })).canEdit).toBe(
      false,
    );
    expect((await loadGeneralTour(member("admin"), { general: repository() })).canEdit).toBe(true);
  });

  it("reads the panel's document", () => {
    const parsed = generalTourDocumentSchema.parse({
      editCount: 1,
      startTourId: A,
      tours: [
        {
          tourId: A,
          kind: "event",
          slug: "feria",
          title: null,
          position: null,
          contentPublished: false,
          ended: true,
          visible: false,
        },
      ],
    });
    expect(parsed.tours[0]?.visible).toBe(false);
  });
});
