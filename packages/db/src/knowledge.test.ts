import { describe, expect, it } from "vitest";

import { createKnowledgeRepository } from "./knowledge";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ID = "5eed4100-0000-4000-8000-000000000001";

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
  return { repo: createKnowledgeRepository(client), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

describe("knowledge repository", () => {
  it("searches with the member's session and maps passages with their pages", async () => {
    const { repo, calls } = session(() =>
      json([
        {
          chunk_id: ID,
          source: "content",
          source_id: ID,
          source_version: 2,
          kind: "knowledge",
          slug: "libro",
          title: "Libro",
          heading: "Capítulo 2",
          body: "Texto.",
          page_from: 14,
          page_to: 15,
          scene_id: null,
          hotspot_id: null,
          ended: false,
          score: 3.2,
        },
      ]),
    );
    expect(await repo.search(TENANT, "reforma agraria", 8)).toEqual([
      {
        chunkId: ID,
        source: "content",
        sourceId: ID,
        sourceVersion: 2,
        kind: "knowledge",
        slug: "libro",
        title: "Libro",
        heading: "Capítulo 2",
        text: "Texto.",
        pages: { from: 14, to: 15 },
        sceneId: null,
        hotspotId: null,
        ended: false,
        score: 3.2,
      },
    ]);
    expect(calls[0]).toEqual({
      path: "/rest/v1/rpc/search_tenant_knowledge",
      body: { p_tenant_id: TENANT, p_query: "reforma agraria", p_limit: 8 },
    });
  });

  it.each([
    [pgError("23514", 400, "document"), { status: "invalid", reason: "document" }],
    [pgError("23514", 400), { status: "invalid", reason: "shape" }],
    [pgError("PT409", 409), { status: "conflict" }],
  ])("maps save errors (%#)", async (response, outcome) => {
    const { repo } = session(() => response.clone());
    expect(
      await repo.saveDraft(TENANT, ID, { title: "L", summary: "", body: [], document: null }, 1),
    ).toEqual(outcome);
  });

  it("maps publication and retirement", async () => {
    expect(
      await session(() => pgError("PT409", 409, "document")).repo.publish(TENANT, ID, 1),
    ).toEqual({ status: "invalid", reason: "document" });
    expect(await session(() => json(null)).repo.retire(TENANT, ID)).toEqual({ status: "retired" });
    expect(await session(() => pgError("PT409", 409)).repo.retire(TENANT, ID)).toEqual({
      status: "conflict",
    });
  });

  it("submits a document and tells an upload that never arrived", async () => {
    expect(await session(() => json("processing")).repo.submitDocument(TENANT, ID)).toBe(
      "processing",
    );
    expect(
      await session(() => pgError("PT409", 409, "not_uploaded")).repo.submitDocument(TENANT, ID),
    ).toBe("not_uploaded");
  });

  it("lists items as draft, published, changed or retired", async () => {
    const item = (id: string, draft: string | null, published: string | null) => ({
      id,
      slug: id.slice(0, 4),
      draft_revision_id: draft,
      published_revision_id: published,
      updated_at: "2026-11-01T00:00:00Z",
      published_at: published ? "2026-11-01T00:00:00Z" : null,
    });
    const uuid = (n: number) => `5eed4100-0000-4000-8000-00000000000${n}`;
    const { repo } = session((url) =>
      url.pathname.endsWith("/content_items")
        ? json([
            item(uuid(1), uuid(5), null),
            item(uuid(2), null, uuid(6)),
            item(uuid(3), uuid(7), uuid(8)),
            item(uuid(4), null, null),
          ])
        : json([
            { id: uuid(5), content_id: uuid(1), revision_no: 1, state: "draft", title: "A" },
            { id: uuid(6), content_id: uuid(2), revision_no: 1, state: "sealed", title: "B" },
            { id: uuid(7), content_id: uuid(3), revision_no: 2, state: "draft", title: "C" },
            { id: uuid(8), content_id: uuid(3), revision_no: 1, state: "sealed", title: "C0" },
            { id: uuid(9), content_id: uuid(4), revision_no: 1, state: "sealed", title: "D" },
          ]),
    );
    expect((await repo.list(TENANT)).map((entry) => [entry.title, entry.status])).toEqual([
      ["A", "draft"],
      ["B", "published"],
      ["C", "changed"],
      ["D", "retired"],
    ]);
  });
});
