import { describe, expect, it } from "vitest";

import { createSupabasePlanTraitReader } from "./plan-traits";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("createSupabasePlanTraitReader (ADR-072)", () => {
  it("reads the visit time and «for children» by kind and slug", async () => {
    const calls: unknown[] = [];
    const reader = createSupabasePlanTraitReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async (_input, init = {}) => {
        calls.push(init.body ? JSON.parse(String(init.body)) : null);
        return json([
          { kind: "destination", slug: "museo", visit_minutes: 90, kids: true },
          { kind: "event", slug: "feria", visit_minutes: null, kids: false },
        ]);
      },
    });
    expect(await reader.planTraits(TENANT)).toEqual(
      new Map([
        ["destination:museo", { visitMinutes: 90, kids: true }],
        ["event:feria", { visitMinutes: null, kids: false }],
      ]),
    );
    expect(calls).toEqual([{ p_tenant_id: TENANT }]);
  });

  it("before the migration, the plans go without them; another error is an error", async () => {
    const before = createSupabasePlanTraitReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () => json({ code: "PGRST202", message: "x", details: null, hint: null }, 404),
    });
    expect((await before.planTraits(TENANT)).size).toBe(0);
    const broken = createSupabasePlanTraitReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () => json({ code: "XX000", message: "x", details: null, hint: null }, 500),
    });
    await expect(broken.planTraits(TENANT)).rejects.toThrow();
  });
});
