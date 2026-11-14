import { describe, expect, it } from "vitest";

import { createCategoryRepository, createSupabasePublishedContentIndexReader } from "./categories";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const CATEGORY = "5eed4700-0000-4000-8000-000000000001";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number) =>
  json({ code, message: "x", details: null, hint: null }, status);

function session(respond: (path: string, body: unknown) => Response) {
  const calls: { path: string; body: unknown }[] = [];
  const client = createSessionClient({
    url: BASE,
    publishableKey: "sb_publishable_test",
    secureCookies: false,
    cookies: { getAll: () => [], setAll: () => undefined },
    fetch: async (input, init = {}) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: url.pathname, body });
      return respond(url.pathname, body);
    },
  });
  return { repo: createCategoryRepository(client), calls };
}

const ROW = { id: CATEGORY, kind: "destination", name: "Miradores", position: 1, used: 2 };

describe("categories adapter (panel)", () => {
  it("lists the categories", async () => {
    const { repo } = session(() => json([ROW]));
    expect(await repo.list(TENANT)).toEqual([ROW]);
  });

  it("before the migration there are none", async () => {
    const { repo } = session(() => pgError("PGRST202", 404));
    expect(await repo.list(TENANT)).toEqual([]);
  });

  it("sends the list with ids only where there are", async () => {
    const { repo, calls } = session(() => json([ROW]));
    expect(
      await repo.save(TENANT, "destination", [
        { id: CATEGORY, name: "Miradores" },
        { name: "Plazas" },
      ]),
    ).toEqual({ status: "saved", categories: [ROW] });
    expect(calls[0]).toEqual({
      path: "/rest/v1/rpc/save_content_categories",
      body: {
        p_tenant_id: TENANT,
        p_kind: "destination",
        p_categories: [{ id: CATEGORY, name: "Miradores" }, { name: "Plazas" }],
      },
    });
  });

  it("translates the base's refusals", async () => {
    for (const [code, http, status] of [
      ["42501", 403, "forbidden"],
      ["23505", 409, "duplicate"],
      ["23514", 400, "invalid"],
    ] as const) {
      const { repo } = session(() => pgError(code, http));
      expect((await repo.save(TENANT, "event", [{ name: "X" }])).status).toBe(status);
    }
    const { repo } = session(() => pgError("XX000", 500));
    await expect(repo.save(TENANT, "event", [{ name: "X" }])).rejects.toThrow();
  });
});

describe("the portal's index", () => {
  function reader(respond: () => Response) {
    return createSupabasePublishedContentIndexReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: () => Promise.resolve(respond()),
    });
  }

  it("maps each row, with or without a category", async () => {
    const index = reader(() =>
      json([
        {
          kind: "destination",
          content_id: "5eed4100-0000-4000-8000-000000000001",
          slug: "mirador-del-valle",
          category_id: CATEGORY,
          category_name: "Miradores",
          category_position: 1,
        },
        {
          kind: "event",
          content_id: "5eed4100-0000-4000-8000-000000000012",
          slug: "festival",
          category_id: null,
          category_name: null,
          category_position: null,
        },
      ]),
    );
    expect(await index.index(TENANT)).toEqual([
      {
        kind: "destination",
        contentId: "5eed4100-0000-4000-8000-000000000001",
        slug: "mirador-del-valle",
        category: { id: CATEGORY, name: "Miradores", position: 1 },
      },
      {
        kind: "event",
        contentId: "5eed4100-0000-4000-8000-000000000012",
        slug: "festival",
        category: null,
      },
    ]);
  });

  it("before the migration the index is empty", async () => {
    expect(await reader(() => pgError("PGRST202", 404)).index(TENANT)).toEqual([]);
  });
});
