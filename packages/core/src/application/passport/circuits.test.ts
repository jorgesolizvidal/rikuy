import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import type { ContentRepository } from "../content/ports";
import {
  canChangeCircuit,
  createCircuit,
  deleteCircuit,
  loadPassport,
  publishCircuit,
  saveCircuit,
  suggestCircuitSlug,
  withdrawCircuit,
  type PassportCircuit,
  type PassportRepository,
} from "./circuits";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const A = "11111111-0000-4000-8000-000000000001";
const B = "11111111-0000-4000-8000-000000000002";

function member(role: OrganizationMembership["role"]): OrganizationMembership {
  return {
    tenantId: TENANT,
    slug: "demo",
    displayName: "Demo",
    role,
    tenantStatus: "active",
  } as OrganizationMembership;
}

const CIRCUIT: PassportCircuit = {
  id: "22222222-0000-4000-8000-000000000001",
  slug: "ruta",
  name: "Ruta",
  summary: "",
  reward: "",
  status: "draft",
  editNo: 2,
  publishedAt: null,
  updatedAt: "2026-11-13T10:00:00Z",
  stops: [],
};

function repository() {
  const calls: string[] = [];
  const passport: PassportRepository = {
    list: async () => [CIRCUIT],
    create: async (_tenant, slug) => {
      calls.push(`create:${slug}`);
      return { status: "created", circuitId: CIRCUIT.id };
    },
    save: async (_tenant, _id, editNo, draft) => {
      calls.push(`save:${editNo}:${draft.stops.join(",")}`);
      return { status: "saved", editNo: editNo + 1 };
    },
    publish: async () => {
      calls.push("publish");
      return { status: "saved", editNo: 3 };
    },
    withdraw: async () => {
      calls.push("withdraw");
      return { status: "saved", editNo: 3 };
    },
    remove: async () => {
      calls.push("remove");
      return { status: "deleted" };
    },
  };
  return { passport, calls };
}

describe("the passport's circuits in the panel", () => {
  it("lists the destinations that can be stops, published first", async () => {
    const content = {
      listDestinations: async () => [
        {
          contentId: B,
          slug: "b",
          title: "Zoológico",
          status: "published",
          updatedAt: "",
          publishedAt: "x",
        },
        {
          contentId: A,
          slug: "a",
          title: "Árbol",
          status: "draft",
          updatedAt: "",
          publishedAt: null,
        },
      ],
    } as unknown as ContentRepository;
    const view = await loadPassport(member("analyst"), {
      passport: repository().passport,
      content,
    });
    expect(view.destinations.map((destination) => destination.title)).toEqual([
      "Zoológico",
      "Árbol",
    ]);
    expect(view).toMatchObject({ canEdit: false, canPublish: false });
  });

  it("lets editors create and save drafts, and only owners and admins publish", async () => {
    const { passport, calls } = repository();
    expect(await createCircuit(member("editor"), passport, { slug: "ruta", name: "Ruta" })).toEqual(
      {
        status: "created",
        circuitId: CIRCUIT.id,
      },
    );
    expect(
      await saveCircuit(member("editor"), passport, {
        circuitId: CIRCUIT.id,
        editNo: 2,
        name: "Ruta",
        summary: "",
        reward: "",
        stops: [A, B],
      }),
    ).toEqual({ status: "saved", editNo: 3 });
    expect(await publishCircuit(member("editor"), passport, CIRCUIT.id, 3)).toEqual({
      status: "forbidden",
    });
    expect(await withdrawCircuit(member("analyst"), passport, CIRCUIT.id, 3)).toEqual({
      status: "forbidden",
    });
    expect(await deleteCircuit(member("editor"), passport, CIRCUIT.id, 3)).toEqual({
      status: "forbidden",
    });
    expect(await createCircuit(member("analyst"), passport, { slug: "x", name: "X" })).toEqual({
      status: "forbidden",
    });
    expect(await publishCircuit(member("admin"), passport, CIRCUIT.id, 3)).toEqual({
      status: "saved",
      editNo: 3,
    });
    expect(calls).toEqual(["create:ruta", `save:2:${A},${B}`, "publish"]);
  });

  it("checks the fields before asking the database", async () => {
    const { passport, calls } = repository();
    expect(
      await createCircuit(member("owner"), passport, { slug: "Ruta Mala", name: "" }),
    ).toMatchObject({
      status: "invalid",
      errors: { slug: expect.any(String), name: expect.any(String) },
    });
    expect(
      await saveCircuit(member("owner"), passport, {
        circuitId: CIRCUIT.id,
        editNo: 2,
        name: "Ruta",
        summary: "",
        reward: "",
        stops: [A, A],
      }),
    ).toMatchObject({ status: "invalid", errors: { stops: expect.any(String) } });
    expect(calls).toEqual([]);
  });

  it("a published circuit is changed only by owners and admins", () => {
    const published = { ...CIRCUIT, status: "published" as const };
    expect(canChangeCircuit("editor", CIRCUIT)).toBe(true);
    expect(canChangeCircuit("editor", published)).toBe(false);
    expect(canChangeCircuit("admin", published)).toBe(true);
    expect(canChangeCircuit("analyst", CIRCUIT)).toBe(false);
  });

  it("suggests the address from the name", () => {
    expect(suggestCircuitSlug("Ruta Histórica de Ucureña")).toBe("ruta-historica-de-ucurena");
  });
});
