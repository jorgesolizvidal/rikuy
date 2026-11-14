import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import { validateDestinationDocument } from "../../contracts/destination";
import {
  categoriesInUse,
  categoryBySlug,
  loadCategories,
  parseCategoryList,
  saveCategories,
  type CategoryRepository,
  type ContentCategory,
  type PortalIndexEntry,
} from "./categories";

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

function repository(categories: ContentCategory[] = []) {
  const calls: unknown[] = [];
  const repo: CategoryRepository = {
    list: () => Promise.resolve(categories),
    save: (tenantId, kind, list) => {
      calls.push({ tenantId, kind, list });
      return Promise.resolve({ status: "saved", categories });
    },
  };
  return { repo, calls };
}

describe("categories of the municipality (ADR-062)", () => {
  it("any member reads them by kind and in order; only owners and admins manage them", async () => {
    const { repo } = repository([
      { id: A, kind: "destination", name: "Plazas", position: 2, used: 1 },
      { id: B, kind: "destination", name: "Miradores", position: 1, used: 0 },
      { id: "c", kind: "event", name: "Ferias", position: 1, used: 3 },
    ]);
    const view = await loadCategories(member("analyst"), { categories: repo });
    expect(view.destination.map((category) => category.name)).toEqual(["Miradores", "Plazas"]);
    expect(view.event.map((category) => category.name)).toEqual(["Ferias"]);
    expect(view.canManage).toBe(false);
    expect((await loadCategories(member("admin"), { categories: repo })).canManage).toBe(true);
  });

  it("editors and analysts cannot save; nothing reaches the base", async () => {
    for (const role of ["editor", "analyst"] as const) {
      const { repo, calls } = repository();
      expect(
        await saveCategories(member(role), "destination", [{ name: "X" }], { categories: repo }),
      ).toEqual({
        status: "forbidden",
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("checks the list before the base: names, duplicates, ids and size", () => {
    expect(
      parseCategoryList([{ name: "  Plazas   y centro " }, { id: A, name: "Museos" }]),
    ).toEqual({
      ok: true,
      list: [{ name: "Plazas y centro" }, { id: A, name: "Museos" }],
    });
    expect(parseCategoryList([{ name: "Plazas" }, { name: "plazas" }])).toEqual({
      ok: false,
      outcome: { status: "duplicate", name: "plazas" },
    });
    expect(parseCategoryList([{ name: " " }])).toMatchObject({ ok: false, outcome: { index: 0 } });
    expect(parseCategoryList([{ name: "x".repeat(41) }])).toMatchObject({ ok: false });
    expect(parseCategoryList([{ id: "plazas", name: "Plazas" }])).toMatchObject({ ok: false });
    expect(
      parseCategoryList([
        { id: A, name: "Uno" },
        { id: A, name: "Dos" },
      ]),
    ).toMatchObject({ ok: false });
    expect(
      parseCategoryList(Array.from({ length: 21 }, (_, n) => ({ name: `C ${String(n)}` }))),
    ).toMatchObject({
      ok: false,
    });
  });

  it("an owner saves the cleaned list of one kind", async () => {
    const { repo, calls } = repository();
    await saveCategories(member("owner"), "event", [{ name: "Ferias " }], { categories: repo });
    expect(calls).toEqual([{ tenantId: TENANT, kind: "event", list: [{ name: "Ferias" }] }]);
  });

  it("a destination document accepts a category id, null or none", () => {
    const base = {
      title: "Plaza",
      summary: "",
      body: [],
      location: null,
      cover: null,
      gallery: [],
    };
    expect(validateDestinationDocument({ ...base, categoryId: A }).ok).toBe(true);
    expect(validateDestinationDocument({ ...base, categoryId: null }).ok).toBe(true);
    expect(validateDestinationDocument(base).ok).toBe(true);
    expect(validateDestinationDocument({ ...base, categoryId: "plazas" }).ok).toBe(false);
  });
});

describe("categories in the portal", () => {
  const entries: PortalIndexEntry[] = [
    {
      kind: "destination",
      contentId: "1",
      slug: "plaza",
      category: { id: A, name: "Plazas", position: 2 },
    },
    {
      kind: "destination",
      contentId: "2",
      slug: "mirador",
      category: { id: B, name: "Miradores", position: 1 },
    },
    { kind: "destination", contentId: "3", slug: "museo", category: null },
    {
      kind: "destination",
      contentId: "4",
      slug: "atrio",
      category: { id: A, name: "Plazas", position: 2 },
    },
    {
      kind: "event",
      contentId: "5",
      slug: "feria",
      category: { id: "e", name: "Ferias", position: 1 },
    },
  ];

  it("only the categories in use, in the municipality's order, with an address each", () => {
    expect(categoriesInUse(entries, "destination")).toEqual([
      { id: B, name: "Miradores", position: 1, slug: "miradores" },
      { id: A, name: "Plazas", position: 2, slug: "plazas" },
    ]);
    expect(categoriesInUse(entries, "event").map((category) => category.slug)).toEqual(["ferias"]);
    // Only among the items listed (an event that ended is not in the agenda).
    expect(categoriesInUse(entries, "destination", new Set(["mirador"]))).toHaveLength(1);
  });

  it("two names that read alike get different addresses", () => {
    const twins: PortalIndexEntry[] = [
      {
        kind: "event",
        contentId: "1",
        slug: "a",
        category: { id: A, name: "Música", position: 1 },
      },
      {
        kind: "event",
        contentId: "2",
        slug: "b",
        category: { id: B, name: "Musica", position: 2 },
      },
    ];
    expect(categoriesInUse(twins, "event").map((category) => category.slug)).toEqual([
      "musica",
      "musica-2",
    ]);
  });

  it("the category of each item by its address", () => {
    const map = categoryBySlug(entries, "destination");
    expect(map.get("plaza")).toEqual({ id: A, name: "Plazas" });
    expect(map.has("museo")).toBe(false);
    expect(map.has("feria")).toBe(false);
  });
});
