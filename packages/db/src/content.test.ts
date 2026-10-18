import { describe, expect, it } from "vitest";

import {
  createContentRepository,
  createSupabasePublishedContentReader,
  createSupabasePublishedEventReader,
  createSupabasePublishedMapReader,
} from "./content";
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
  const cover = {
    assetId: "5eed3000-0000-4000-8000-000000000001",
    version: 1,
    alt: "El mirador",
    width: 1200,
    height: 800,
  };

  it("lists published destinations with their location and cover size", async () => {
    const reader = createSupabasePublishedContentReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async (input) => {
        expect(String(input)).toContain("/rest/v1/rpc/portal_destinations");
        return json([
          {
            slug: "mirador",
            title: "Mirador",
            summary: "Vista",
            latitude: -17.39,
            longitude: -66.15,
            cover,
            published_at: "2026-10-18T00:00:00Z",
            updated_at: "2026-10-18T01:00:00Z",
          },
        ]);
      },
    });
    expect(await reader.list(TENANT)).toEqual([
      {
        slug: "mirador",
        title: "Mirador",
        summary: "Vista",
        location: { lat: -17.39, lng: -66.15 },
        cover,
        publishedAt: "2026-10-18T00:00:00Z",
        updatedAt: "2026-10-18T01:00:00Z",
      },
    ]);
  });

  it("reads one destination and drops gallery images that are no longer public", async () => {
    const reader = createSupabasePublishedContentReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () =>
        json([
          {
            slug: "mirador",
            revision_no: 2,
            title: "Mirador",
            summary: "Vista",
            body: [{ type: "paragraph", children: [{ type: "text", text: "Hola" }] }],
            latitude: null,
            longitude: null,
            cover: null,
            gallery: [cover, null],
            published_at: "2026-10-18T00:00:00Z",
            updated_at: "2026-10-18T01:00:00Z",
          },
        ]),
    });
    const destination = await reader.find(TENANT, "mirador");
    expect(destination?.revisionNo).toBe(2);
    expect(destination?.location).toBeNull();
    expect(destination?.gallery).toEqual([cover]);
    expect(destination?.body).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "Hola" }] },
    ]);
  });

  it("returns null for an unknown slug", async () => {
    const reader = createSupabasePublishedContentReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () => json([]),
    });
    expect(await reader.find(TENANT, "nada")).toBeNull();
  });
});

describe("events", () => {
  it("lists the panel agenda with status and whether each event ended", async () => {
    const { repo, calls } = session(() =>
      json([
        {
          content_id: CONTENT,
          slug: "feria",
          title: "Feria",
          has_draft: true,
          is_published: true,
          schedule: { allDay: true, start: "2026-11-02", end: "2026-11-03" },
          starts_at: "2026-11-02T04:00:00+00:00",
          ends_at: "2026-11-04T04:00:00+00:00",
          ended: false,
          updated_at: "2026-10-18T00:00:00Z",
          published_at: "2026-10-17T00:00:00Z",
        },
      ]),
    );
    expect(await repo.listEvents(TENANT)).toEqual([
      {
        contentId: CONTENT,
        slug: "feria",
        title: "Feria",
        status: "changed",
        schedule: { allDay: true, start: "2026-11-02", end: "2026-11-03" },
        ended: false,
        updatedAt: "2026-10-18T00:00:00Z",
        publishedAt: "2026-10-17T00:00:00Z",
      },
    ]);
    expect(calls[0]?.path).toBe("/rest/v1/rpc/list_content_events");
  });

  it("creates events with their kind and reports a rejected venue", async () => {
    const created = session(() => json([{ content_id: CONTENT }]));
    expect(await created.repo.createEvent(TENANT, "feria", "Feria")).toEqual({
      status: "created",
      contentId: CONTENT,
    });
    expect(created.calls[0]?.body).toMatchObject({ p_kind: "event", p_slug: "feria" });
    const venue = session(() => pgError("23514", 400, "venue"));
    expect(await venue.repo.saveDraft(TENANT, CONTENT, doc, 1)).toEqual({
      status: "invalid",
      reason: "venue",
    });
  });

  it("only finds items of the requested kind", async () => {
    const { repo, calls } = session(() => json(null));
    expect(await repo.findEvent(TENANT, CONTENT)).toBeNull();
    expect(calls[0]?.path).toContain("kind=eq.event");
    await repo.findDestination(TENANT, CONTENT);
    expect(calls[1]?.path).toContain("kind=eq.destination");
  });

  it("reads upcoming events with instants and their venue", async () => {
    const reader = createSupabasePublishedEventReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () =>
        json([
          {
            slug: "feria",
            title: "Feria",
            summary: "Música",
            schedule: { allDay: false, start: "2026-11-02T19:00", end: "2026-11-02T22:00" },
            starts_at: "2026-11-02T23:00:00+00:00",
            ends_at: "2026-11-03T02:00:00+00:00",
            latitude: -17.39,
            longitude: -66.15,
            cover: null,
            venue: { slug: "mirador", title: "Mirador" },
            published_at: "2026-10-18T00:00:00Z",
            updated_at: "2026-10-18T01:00:00Z",
          },
        ]),
    });
    const [event] = await reader.list(TENANT);
    expect(event).toMatchObject({
      startsAt: "2026-11-02T23:00:00.000Z",
      endsAt: "2026-11-03T02:00:00.000Z",
      location: { lat: -17.39, lng: -66.15 },
      venue: { slug: "mirador", title: "Mirador" },
    });
  });
});

describe("map reader", () => {
  it("asks for places inside the area with the chosen layers and a cap", async () => {
    const bodies: unknown[] = [];
    const reader = createSupabasePublishedMapReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      limit: 50,
      fetch: async (_input, init = {}) => {
        bodies.push(JSON.parse(String(init.body)));
        return json([
          {
            kind: "event",
            slug: "feria",
            title: "Feria",
            summary: "",
            latitude: -17.39,
            longitude: -66.15,
            schedule: { allDay: true, start: "2026-11-02", end: "2026-11-02" },
            starts_at: "2026-11-02T04:00:00+00:00",
            cover: null,
          },
        ]);
      },
    });
    const places = await reader.places(
      TENANT,
      { west: -66.2, south: -17.4, east: -66.1, north: -17.3 },
      ["event"],
    );
    expect(places).toEqual([
      {
        kind: "event",
        slug: "feria",
        title: "Feria",
        summary: "",
        location: { lat: -17.39, lng: -66.15 },
        schedule: { allDay: true, start: "2026-11-02", end: "2026-11-02" },
        cover: null,
      },
    ]);
    expect(bodies[0]).toEqual({
      p_tenant_id: TENANT,
      p_west: -66.2,
      p_south: -17.4,
      p_east: -66.1,
      p_north: -17.3,
      p_kinds: ["event"],
      p_limit: 50,
    });
    expect(await reader.places(TENANT, { west: 0, south: 0, east: 1, north: 1 }, [])).toEqual([]);
  });

  it("reads an empty extent as no bounds", async () => {
    const reader = createSupabasePublishedMapReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async () =>
        json([{ west: null, south: null, east: null, north: null, destinations: 0, events: 0 }]),
    });
    expect(await reader.extent(TENANT)).toEqual({ bounds: null, destinations: 0, events: 0 });
  });
});
