import { describe, expect, it } from "vitest";

import { createNoticeRepository, mapPortalNoticeRow } from "./notices";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ITEM = "5eed4100-0000-4000-8000-000000000001";
const PUBLISHED = "5eed4200-0000-4000-8000-000000000001";
const DRAFT = "5eed4200-0000-4000-8000-000000000002";

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
  return { repo: createNoticeRepository(client), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

describe("notice repository", () => {
  it("lists notices with the published validity and the one being edited", async () => {
    const { repo } = session((url) =>
      url.pathname.endsWith("/content_items")
        ? json([
            {
              id: ITEM,
              slug: "corte-de-ruta",
              draft_revision_id: DRAFT,
              published_revision_id: PUBLISHED,
              updated_at: "2026-11-16T12:00:00Z",
              published_at: "2026-11-15T12:00:00Z",
            },
          ])
        : json([
            {
              id: PUBLISHED,
              content_id: ITEM,
              revision_no: 1,
              state: "sealed",
              title: "Corte de ruta",
              notice_from_local: null,
              notice_until_local: "2026-11-20T18:00:00",
            },
            {
              id: DRAFT,
              content_id: ITEM,
              revision_no: 2,
              state: "draft",
              title: "Corte de ruta (renovado)",
              notice_from_local: "2026-11-20T18:00:00",
              notice_until_local: "2026-12-20T18:00:00",
            },
          ]),
    );
    expect(await repo.list(TENANT)).toEqual([
      {
        contentId: ITEM,
        slug: "corte-de-ruta",
        title: "Corte de ruta (renovado)",
        status: "changed",
        published: { from: null, until: "2026-11-20T18:00" },
        validity: { from: "2026-11-20T18:00", until: "2026-12-20T18:00" },
        updatedAt: "2026-11-16T12:00:00Z",
        publishedAt: "2026-11-15T12:00:00Z",
      },
    ]);
  });

  it("before the migration (no kind, no columns) there are no notices", async () => {
    const { repo } = session(() => pgError("22P02", 400));
    expect(await repo.list(TENANT)).toEqual([]);
  });

  it.each([
    ["place", "place"],
    [null, "shape"],
  ])("a refused draft (hint %s) is reported as %s", async (hint, reason) => {
    const { repo } = session(() => pgError("23514", 400, hint));
    expect(
      await repo.saveDraft(
        TENANT,
        ITEM,
        {
          title: "Aviso",
          summary: "",
          body: [],
          validity: { from: null, until: null },
          placeId: null,
        },
        1,
      ),
    ).toEqual({ status: "invalid", reason });
  });

  it.each([
    ["validity", "validity"],
    ["incomplete", "incomplete"],
  ])("a refused publication (hint %s) is reported as %s", async (hint, reason) => {
    const { repo, calls } = session(() => pgError("23514", 400, hint));
    expect(await repo.publish(TENANT, ITEM, 3)).toEqual({ status: "invalid", reason });
    expect(calls[0]?.path).toBe("/rest/v1/rpc/publish_content");
  });

  it("retires with retire_content; an editor is refused", async () => {
    const ok = session(() => new Response(null, { status: 204 }));
    expect(await ok.repo.retire(TENANT, ITEM)).toEqual({ status: "retired" });
    expect(ok.calls[0]).toEqual({
      path: "/rest/v1/rpc/retire_content",
      body: { p_tenant_id: TENANT, p_content_id: ITEM },
    });
    const refused = session(() => pgError("42501", 403));
    expect(await refused.repo.retire(TENANT, ITEM)).toEqual({ status: "forbidden" });
  });
});

describe("the portal's notices", () => {
  it("maps a row with its instants and its published place", () => {
    expect(
      mapPortalNoticeRow({
        slug: "corte-de-ruta",
        title: "Corte de ruta",
        summary: "El puente está cerrado.",
        body: [],
        starts_at: null,
        ends_at: "2026-11-20T22:00:00+00:00",
        place_kind: "destination",
        place_slug: "puente-viejo",
        place_title: "Puente viejo",
      }),
    ).toEqual({
      slug: "corte-de-ruta",
      title: "Corte de ruta",
      summary: "El puente está cerrado.",
      body: [],
      startsAt: null,
      endsAt: "2026-11-20T22:00:00.000Z",
      place: { kind: "destination", slug: "puente-viejo", title: "Puente viejo" },
    });
  });

  it("without a published place, none", () => {
    expect(
      mapPortalNoticeRow({
        slug: "s",
        title: "T",
        summary: "S",
        body: [],
        starts_at: "2026-11-20T12:00:00+00:00",
        ends_at: "2026-11-21T12:00:00+00:00",
        place_kind: null,
        place_slug: null,
        place_title: null,
      }).place,
    ).toBeNull();
  });
});
