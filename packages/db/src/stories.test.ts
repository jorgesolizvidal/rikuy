import { describe, expect, it } from "vitest";

import { createSessionClient } from "./session-client";
import { createStoryRepository, mapPortalStoryRow } from "./stories";

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
  return { repo: createStoryRepository(client), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

const document = {
  title: "La noche de la helada",
  summary: "",
  body: [{ type: "paragraph" as const, children: [{ type: "text" as const, text: "Fogatas." }] }],
  author: "Doña Rosa",
  anonymous: false,
  community: "",
  placeId: null,
  consent: true,
};

describe("story repository", () => {
  it("lists stories with who tells the version being edited", async () => {
    const { repo } = session((url) =>
      url.pathname.endsWith("/content_items")
        ? json([
            {
              id: ITEM,
              slug: "la-helada",
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
              title: "La helada",
              story_author: "Doña Rosa",
              story_anonymous: false,
            },
            {
              id: DRAFT,
              content_id: ITEM,
              revision_no: 2,
              state: "draft",
              title: "La noche de la helada",
              story_author: null,
              story_anonymous: true,
            },
          ]),
    );
    expect(await repo.list(TENANT)).toEqual([
      {
        contentId: ITEM,
        slug: "la-helada",
        title: "La noche de la helada",
        teller: "Anónimo",
        status: "changed",
        updatedAt: "2026-11-25T12:00:00Z",
        publishedAt: "2026-11-24T12:00:00Z",
      },
    ]);
  });

  it("has no stories before the migration", async () => {
    const { repo } = session(() => pgError("22P02", 400));
    expect(await repo.list(TENANT)).toEqual([]);
  });

  it("tells a place the database refuses apart from other invalid drafts", async () => {
    const place = session(() => pgError("23514", 400, "place"));
    expect(await place.repo.saveDraft(TENANT, ITEM, document, 1)).toEqual({
      status: "invalid",
      reason: "place",
    });
    const other = session(() => pgError("23514", 400));
    expect(await other.repo.saveDraft(TENANT, ITEM, document, 1)).toEqual({ status: "invalid" });
  });

  it("tells a missing consent apart from a missing text", async () => {
    const consent = session(() => pgError("23514", 400, "consent"));
    expect(await consent.repo.publish(TENANT, ITEM, 2)).toEqual({
      status: "invalid",
      reason: "consent",
    });
    const incomplete = session(() => pgError("23514", 400, "incomplete"));
    expect(await incomplete.repo.publish(TENANT, ITEM, 2)).toEqual({
      status: "invalid",
      reason: "incomplete",
    });
  });

  it("sends the document as written and the expected edit", async () => {
    const { repo, calls } = session(() => json([{ revision_no: 2, edit_count: 3 }]));
    expect(await repo.saveDraft(TENANT, ITEM, document, 2)).toEqual({
      status: "saved",
      revisionNo: 2,
      editCount: 3,
    });
    expect(calls[0]?.body).toEqual({
      p_tenant_id: TENANT,
      p_content_id: ITEM,
      p_document: document,
      p_expected_edit: 2,
    });
  });
});

describe("the portal's stories", () => {
  const row = {
    slug: "la-helada",
    title: "La noche de la helada",
    summary: "",
    body: [],
    author: "Doña Rosa",
    anonymous: false,
    community: "Vecina de la plaza",
    place_slug: "plaza",
    place_title: "Plaza principal",
    published_at: "2026-11-25T12:00:00Z",
  };

  it("maps who tells it and its place", () => {
    expect(mapPortalStoryRow(row)).toMatchObject({
      author: "Doña Rosa",
      community: "Vecina de la plaza",
      place: { slug: "plaza", title: "Plaza principal" },
    });
  });

  it("never shows a name for an anonymous story", () => {
    expect(mapPortalStoryRow({ ...row, anonymous: true }).author).toBeNull();
    expect(mapPortalStoryRow({ ...row, place_slug: null, place_title: null }).place).toBeNull();
  });
});
