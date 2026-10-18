import { describe, expect, it } from "vitest";

import { createContentRepository, createSupabasePublishedContentReader } from "./content";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const CONTENT = "5eed4100-0000-4000-8000-000000000001";

type Route = (url: URL, body: unknown) => Response;

function session(route: Route) {
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
  return { repo: createContentRepository(client), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

const doc = {
  title: "Mirador",
  summary: "",
  body: [],
  location: null,
  cover: null,
  gallery: [],
};

describe("content repository", () => {
  it.each([
    [pgError("PT409", 409, "slug"), { status: "slug_taken" }],
    [pgError("23514", 400), { status: "invalid" }],
    [pgError("42501", 403), { status: "forbidden" }],
  ])("maps create errors (%#)", async (response, outcome) => {
    const { repo } = session(() => response.clone());
    expect(await repo.createDestination(TENANT, "mirador", "Mirador")).toEqual(outcome);
  });

  it("sends the whole document and the expected edit when saving", async () => {
    const { repo, calls } = session(() =>
      json([{ revision_id: CONTENT, revision_no: 2, edit_count: 5 }]),
    );
    expect(await repo.saveDraft(TENANT, CONTENT, doc, 4)).toEqual({
      status: "saved",
      revisionNo: 2,
      editCount: 5,
    });
    expect(calls[0]).toEqual({
      path: "/rest/v1/rpc/save_content_draft",
      body: { p_tenant_id: TENANT, p_content_id: CONTENT, p_document: doc, p_expected_edit: 4 },
    });
  });

  it.each([
    ["save", pgError("23514", 400, "media"), { status: "invalid", reason: "media" }],
    ["save", pgError("23514", 400), { status: "invalid", reason: "shape" }],
    ["save", pgError("PT409", 409), { status: "conflict" }],
    ["publish", pgError("PT409", 409, "media"), { status: "invalid", reason: "media" }],
    ["publish", pgError("23514", 400, "incomplete"), { status: "invalid", reason: "incomplete" }],
    ["publish", pgError("PT409", 409), { status: "conflict" }],
    ["discard", pgError("PT409", 409, "never_published"), { status: "never_published" }],
    ["restore", pgError("PT404", 404), { status: "not_found" }],
  ])("maps %s errors (%#)", async (operation, response, outcome) => {
    const { repo } = session(() => response.clone());
    const result =
      operation === "save"
        ? await repo.saveDraft(TENANT, CONTENT, doc, 1)
        : operation === "publish"
          ? await repo.publish(TENANT, CONTENT, 1)
          : operation === "discard"
            ? await repo.discardDraft(TENANT, CONTENT, 1)
            : await repo.restore(TENANT, CONTENT, CONTENT);
    expect(result).toEqual(outcome);
  });

  it("throws on unexpected database errors instead of hiding them", async () => {
    const { repo } = session(() => pgError("XX000", 500));
    await expect(repo.publish(TENANT, CONTENT, 1)).rejects.toThrow("Publishing failed (XX000)");
  });

  it("lists destinations with the title being edited and their status", async () => {
    const draft = "5eed4200-0000-4000-8000-00000000000d";
    const published = "5eed4200-0000-4000-8000-00000000000a";
    const { repo } = session((url) =>
      url.pathname.endsWith("/content_items")
        ? json([
            {
              id: CONTENT,
              slug: "b",
              draft_revision_id: draft,
              published_revision_id: published,
              updated_at: "t",
              published_at: "p",
            },
            {
              id: published,
              slug: "a",
              draft_revision_id: null,
              published_revision_id: published,
              updated_at: "t",
              published_at: "p",
            },
          ])
        : json([
            { id: draft, title: "Zona nueva" },
            { id: published, title: "Árbol" },
          ]),
    );
    expect(
      (await repo.listDestinations(TENANT)).map((entry) => [entry.title, entry.status]),
    ).toEqual([
      ["Árbol", "published"],
      ["Zona nueva", "changed"],
    ]);
  });
});

describe("published destination reader", () => {
  it("reads the published revision with its location", async () => {
    const reader = createSupabasePublishedContentReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () =>
        json([
          {
            content_id: CONTENT,
            slug: "mirador",
            revision_no: 2,
            title: "Mirador",
            summary: "Vista",
            latitude: -17.39,
            longitude: -66.15,
            cover: null,
            published_at: "2026-10-18T00:00:00Z",
          },
        ]),
    });
    expect(await reader.list(TENANT)).toEqual([
      {
        contentId: CONTENT,
        slug: "mirador",
        revisionNo: 2,
        title: "Mirador",
        summary: "Vista",
        location: { lat: -17.39, lng: -66.15 },
        cover: null,
        publishedAt: "2026-10-18T00:00:00Z",
      },
    ]);
  });
});
