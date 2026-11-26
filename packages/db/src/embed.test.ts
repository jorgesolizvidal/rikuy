import { describe, expect, it } from "vitest";

import {
  createEmbedRepository,
  createPlatformEmbedRepository,
  createSupabasePublishedWebLinkReader,
} from "./embed";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000002";
const ITEM = "5eed4300-0000-4000-8000-000000000001";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

function client(route: (url: URL, body: unknown) => Response) {
  const calls: { path: string; body: unknown }[] = [];
  const session = createSessionClient({
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
      return route(url, body);
    },
  });
  return { session, calls };
}

describe("the websites where the assistant may be embedded (ADR-071)", () => {
  it("lets the operator list, add and remove them", async () => {
    const { session, calls } = client((url) =>
      url.pathname.endsWith("platform_embed_origins")
        ? json([{ origin: "https://www.muni.gob.bo", created_at: "2026-11-25T10:00:00Z" }])
        : json(["https://www.muni.gob.bo"]),
    );
    const repo = createPlatformEmbedRepository(session);
    expect(await repo.list(TENANT)).toEqual([
      { origin: "https://www.muni.gob.bo", createdAt: "2026-11-25T10:00:00Z" },
    ]);
    expect(await repo.add(TENANT, "https://www.muni.gob.bo")).toEqual({
      status: "updated",
      origins: ["https://www.muni.gob.bo"],
    });
    expect(calls[1]).toEqual({
      path: "/rest/v1/rpc/platform_add_embed_origin",
      body: { p_tenant_id: TENANT, p_origin: "https://www.muni.gob.bo" },
    });
  });

  it("reads the database's refusals", async () => {
    for (const [code, status, outcome] of [
      ["42501", 403, "forbidden"],
      ["PT404", 400, "not_found"],
      ["PT409", 409, "too_many"],
      ["23514", 400, "invalid"],
    ] as const) {
      const repo = createPlatformEmbedRepository(client(() => pgError(code, status)).session);
      expect(await repo.add(TENANT, "https://x.bo"), code).toEqual({ status: outcome });
    }
    const denied = createPlatformEmbedRepository(client(() => pgError("42501", 403)).session);
    expect(await denied.list(TENANT)).toBeNull();
  });

  it("gives a member nothing before the migration", async () => {
    const repo = createEmbedRepository(client(() => pgError("PGRST202", 404)).session);
    expect(await repo.origins(TENANT)).toEqual([]);
    expect(await repo.webLink(TENANT, ITEM)).toBeNull();
  });

  it("saves a link and tells a website that is not authorized from a bad address", async () => {
    const saved = createEmbedRepository(
      client(() => json("https://www.muni.gob.bo/museo")).session,
    );
    expect(await saved.setWebLink(TENANT, ITEM, "https://www.muni.gob.bo/museo")).toEqual({
      status: "saved",
      url: "https://www.muni.gob.bo/museo",
    });
    const origin = createEmbedRepository(client(() => pgError("23514", 400, "origin")).session);
    expect(await origin.setWebLink(TENANT, ITEM, "https://x.bo/a")).toEqual({ status: "origin" });
    const url = createEmbedRepository(client(() => pgError("23514", 400, "url")).session);
    expect(await url.setWebLink(TENANT, ITEM, "https://x.bo/a")).toEqual({ status: "invalid" });
    const forbidden = createEmbedRepository(client(() => pgError("42501", 403)).session);
    expect(await forbidden.setWebLink(TENANT, ITEM, null)).toEqual({ status: "forbidden" });
  });

  it("reads the links of what is published, by kind and address", async () => {
    const reader = createSupabasePublishedWebLinkReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () =>
        json([
          { kind: "destination", slug: "museo", url: "https://www.muni.gob.bo/museo" },
          { kind: "service", slug: "cajero", url: "https://www.muni.gob.bo/servicios" },
        ]),
    });
    expect(await reader.links(TENANT)).toEqual(
      new Map([
        ["destination:museo", "https://www.muni.gob.bo/museo"],
        ["service:cajero", "https://www.muni.gob.bo/servicios"],
      ]),
    );
    const before = createSupabasePublishedWebLinkReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () => pgError("PGRST202", 404),
    });
    expect(await before.links(TENANT)).toEqual(new Map());
  });
});
