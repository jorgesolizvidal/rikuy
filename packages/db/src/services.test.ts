import { describe, expect, it } from "vitest";

import { createServiceRepository, mapPortalServiceRow } from "./services";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ITEM = "5eed4300-0000-4000-8000-000000000001";
const PUBLISHED = "5eed4400-0000-4000-8000-000000000001";
const DRAFT = "5eed4400-0000-4000-8000-000000000002";

function session(route: (url: URL, body: unknown) => Response) {
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
      calls.push({ path: `${url.pathname}${url.search}`, body });
      return route(url, body);
    },
  });
  return { repo: createServiceRepository(client), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

const document = {
  title: "Cajero",
  summary: "",
  category: "cash" as const,
  hours: null,
  phone: null,
  whatsapp: null,
  address: "Plaza 1",
  location: null,
};

describe("service repository", () => {
  it("lists services with the category of the version being edited", async () => {
    const { repo, calls } = session((url) =>
      url.pathname.endsWith("/content_items")
        ? json([
            {
              id: ITEM,
              slug: "cajero",
              draft_revision_id: DRAFT,
              published_revision_id: PUBLISHED,
              updated_at: "2026-11-25T12:00:00Z",
              published_at: "2026-11-24T12:00:00Z",
            },
          ])
        : json([
            {
              id: PUBLISHED,
              content_id: ITEM,
              revision_no: 1,
              state: "sealed",
              title: "Cajero",
              service_category: "cash",
            },
            {
              id: DRAFT,
              content_id: ITEM,
              revision_no: 2,
              state: "draft",
              title: "Cajero del banco",
              service_category: "cash",
            },
          ]),
    );
    expect(await repo.list(TENANT)).toEqual([
      {
        contentId: ITEM,
        slug: "cajero",
        title: "Cajero del banco",
        category: "cash",
        status: "changed",
        updatedAt: "2026-11-25T12:00:00Z",
        publishedAt: "2026-11-24T12:00:00Z",
      },
    ]);
    expect(calls[0]?.path).toContain("kind=eq.service");
  });

  it("before the migration (no kind, no columns) there are no services", async () => {
    const { repo } = session(() => pgError("22P02", 400));
    expect(await repo.list(TENANT)).toEqual([]);
  });

  it("a refused draft or publication is reported as invalid", async () => {
    const refused = session(() => pgError("23514", 400, "incomplete"));
    expect(await refused.repo.saveDraft(TENANT, ITEM, document, 1)).toEqual({ status: "invalid" });
    expect(await refused.repo.publish(TENANT, ITEM, 2)).toEqual({ status: "invalid" });
    expect(refused.calls.map((call) => call.path)).toEqual([
      "/rest/v1/rpc/save_content_draft",
      "/rest/v1/rpc/publish_content",
    ]);
  });

  it("retires with retire_content; an editor is refused", async () => {
    const ok = session(() => new Response(null, { status: 204 }));
    expect(await ok.repo.retire(TENANT, ITEM)).toEqual({ status: "retired" });
    const refused = session(() => pgError("42501", 403));
    expect(await refused.repo.retire(TENANT, ITEM)).toEqual({ status: "forbidden" });
  });
});

describe("the portal's services", () => {
  it("maps a row with its place and hours", () => {
    expect(
      mapPortalServiceRow({
        slug: "casona",
        title: "La Casona",
        summary: "Almuerzos.",
        category: "food",
        hours: { mode: "always", note: "" },
        phone: "4 4441234",
        whatsapp: "+591 70000000",
        address: "Calle Bolívar 12",
        latitude: -17.4,
        longitude: -66.1,
      }),
    ).toEqual({
      slug: "casona",
      title: "La Casona",
      summary: "Almuerzos.",
      category: "food",
      hours: { mode: "always", note: "" },
      phone: "4 4441234",
      whatsapp: "+591 70000000",
      address: "Calle Bolívar 12",
      location: { lat: -17.4, lng: -66.1 },
    });
  });

  it("without a place, none; unreadable hours, none", () => {
    const row = mapPortalServiceRow({
      slug: "cajero",
      title: "Cajero",
      summary: "",
      category: "cash",
      hours: { mode: "nope" },
      phone: null,
      whatsapp: null,
      address: "Plaza 1",
      latitude: null,
      longitude: null,
    });
    expect([row.location, row.hours]).toEqual([null, null]);
  });
});
