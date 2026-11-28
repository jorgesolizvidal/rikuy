import { describe, expect, it } from "vitest";

import { createFaqRepository, createSupabasePublishedFaqReader, mapPortalFaqRow } from "./faqs";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ITEM = "5eed4500-0000-4000-8000-000000000001";
const PUBLISHED = "5eed4600-0000-4000-8000-000000000001";
const DRAFT = "5eed4600-0000-4000-8000-000000000002";

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
  return { repo: createFaqRepository(client), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

const document = {
  title: "¿Hay cajero automático?",
  summary: "Sí, en la plaza.",
  body: [],
  topic: "services" as const,
  placeId: null,
};

describe("question repository", () => {
  it("lists questions with the topic of the version being edited", async () => {
    const { repo, calls } = session((url) =>
      url.pathname.endsWith("/content_items")
        ? json([
            {
              id: ITEM,
              slug: "hay-cajero",
              draft_revision_id: DRAFT,
              published_revision_id: PUBLISHED,
              updated_at: "2026-11-27T12:00:00Z",
              published_at: "2026-11-26T12:00:00Z",
            },
          ])
        : json([
            {
              id: PUBLISHED,
              content_id: ITEM,
              revision_no: 1,
              state: "sealed",
              title: "¿Hay cajero?",
              faq_topic: "other",
            },
            {
              id: DRAFT,
              content_id: ITEM,
              revision_no: 2,
              state: "draft",
              title: "¿Hay cajero automático?",
              faq_topic: "services",
            },
          ]),
    );
    expect(await repo.list(TENANT)).toEqual([
      {
        contentId: ITEM,
        slug: "hay-cajero",
        question: "¿Hay cajero automático?",
        topic: "services",
        status: "changed",
        updatedAt: "2026-11-27T12:00:00Z",
        publishedAt: "2026-11-26T12:00:00Z",
      },
    ]);
    expect(calls[0]?.path).toContain("kind=eq.faq");
  });

  it("has no questions before the migration", async () => {
    const { repo } = session(() => pgError("22P02", 400));
    expect(await repo.list(TENANT)).toEqual([]);
  });

  it("tells a place the database refuses apart from other invalid drafts, and a missing answer", async () => {
    const place = session(() => pgError("23514", 400, "place"));
    expect(await place.repo.saveDraft(TENANT, ITEM, document, 1)).toEqual({
      status: "invalid",
      reason: "place",
    });
    const other = session(() => pgError("23514", 400));
    expect(await other.repo.saveDraft(TENANT, ITEM, document, 1)).toEqual({ status: "invalid" });
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

describe("the portal's questions", () => {
  const row = {
    slug: "hay-cajero",
    question: "¿Hay cajero automático?",
    answer: "Sí, en la plaza.",
    body: [],
    topic: "services",
    place_kind: "destination",
    place_slug: "plaza",
    place_title: "Plaza principal",
    published_at: "2026-11-27T12:00:00Z",
  };

  it("maps its answer, its topic and its place", () => {
    expect(mapPortalFaqRow(row)).toEqual({
      slug: "hay-cajero",
      question: "¿Hay cajero automático?",
      answer: "Sí, en la plaza.",
      body: [],
      topic: "services",
      place: { kind: "destination", slug: "plaza", title: "Plaza principal" },
      publishedAt: "2026-11-27T12:00:00Z",
    });
  });

  it("an unknown topic is «other» and a missing place is none", () => {
    const mapped = mapPortalFaqRow({ ...row, topic: "food", place_slug: null });
    expect(mapped.topic).toBe("other");
    expect(mapped.place).toBeNull();
  });

  it("has no questions before the migration", async () => {
    const reader = createSupabasePublishedFaqReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () => pgError("PGRST202", 404),
    });
    expect(await reader.list(TENANT)).toEqual([]);
  });
});
