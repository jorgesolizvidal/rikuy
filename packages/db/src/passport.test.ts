import { describe, expect, it } from "vitest";

import {
  createPassportRepository,
  createStampCodeRepository,
  createSupabasePublishedPassportReader,
  createSupabasePublishedStampReader,
} from "./passport";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const CIRCUIT = "5eed4600-0000-4000-8000-000000000001";
const PLAZA = "5eed4100-0000-4000-8000-000000000004";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

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
  return {
    repo: createPassportRepository(client),
    codes: createStampCodeRepository(client),
    calls,
  };
}

describe("passport adapter (panel)", () => {
  it("lists the circuits with their stops", async () => {
    const { repo } = session(() =>
      json([
        {
          id: CIRCUIT,
          slug: "ruta-del-valle",
          name: "Ruta del valle",
          summary: "",
          reward: "Una postal.",
          status: "published",
          editNo: 2,
          publishedAt: "2026-11-12T00:00:00Z",
          updatedAt: "2026-11-12T00:00:00Z",
          stops: [
            { contentId: PLAZA, position: 1, slug: "plaza", title: "Plaza", published: true },
          ],
        },
      ]),
    );
    const [circuit] = await repo.list(TENANT);
    expect(circuit).toMatchObject({ slug: "ruta-del-valle", stops: [{ title: "Plaza" }] });
  });

  it("sends the stops in order and returns the new edit number", async () => {
    const { repo, calls } = session(() => json(3));
    expect(
      await repo.save(TENANT, CIRCUIT, 2, { name: "R", summary: "", reward: "", stops: [PLAZA] }),
    ).toEqual({ status: "saved", editNo: 3 });
    expect(calls[0]).toMatchObject({
      path: "/rest/v1/rpc/save_passport_circuit",
      body: { p_edit_no: 2, p_stops: [PLAZA] },
    });
  });

  it("turns the database's codes into outcomes", async () => {
    const cases = [
      [pgError("PT409", 409, "stale"), { status: "stale" }],
      [pgError("42501", 403), { status: "forbidden" }],
      [pgError("P0002", 404), { status: "not_found" }],
      [pgError("23514", 400, "incomplete"), { status: "incomplete" }],
      [pgError("22023", 400, "stops"), { status: "invalid" }],
    ] as const;
    for (const [response, outcome] of cases) {
      const { repo } = session(() => response.clone());
      expect(await repo.publish(TENANT, CIRCUIT, 2)).toEqual(outcome);
    }
    expect(await session(() => pgError("23505", 409)).repo.create(TENANT, "r", "R")).toEqual({
      status: "taken",
    });
    expect(
      await session(() => pgError("23514", 400, "published")).repo.remove(TENANT, CIRCUIT, 2),
    ).toEqual({ status: "published" });
  });

  it("before the migration there are no circuits", async () => {
    expect(await session(() => pgError("PGRST202", 404)).repo.list(TENANT)).toEqual([]);
  });
});

describe("passport reader (portal)", () => {
  it("reads the published circuits with their stops' location", async () => {
    const reader = createSupabasePublishedPassportReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async (input) => {
        expect(String(input)).toContain("/rest/v1/rpc/portal_passport");
        return json([
          {
            slug: "ruta-del-valle",
            name: "Ruta del valle",
            summary: "",
            reward: "",
            publishedAt: "2026-11-12T02:31:06.36-04:00",
            stops: [
              {
                id: PLAZA,
                slug: "plaza",
                title: "Plaza",
                summary: "",
                latitude: -17.39,
                longitude: -66.15,
                cover: null,
              },
              {
                slug: "mirador",
                title: "Mirador",
                summary: "",
                latitude: null,
                longitude: null,
                cover: null,
              },
            ],
          },
        ]);
      },
    });
    const [circuit] = await reader.circuits(TENANT);
    expect(circuit?.publishedAt).toBe("2026-11-12T06:31:06.360Z");
    expect(circuit?.stops.map((stop) => stop.location)).toEqual([
      { lat: -17.39, lng: -66.15 },
      null,
    ]);
    // A stop without its place (before the stamps migration) has none.
    expect(circuit?.stops.map((stop) => stop.id)).toEqual([PLAZA, null]);
  });
});

describe("stamp codes (panel)", () => {
  it("lists the code of each stop", async () => {
    const { codes, calls } = session(() =>
      json([
        {
          contentId: PLAZA,
          slug: "plaza",
          title: "Plaza",
          published: true,
          code: "7qVtpcGPSWzBExzRe9Bp4w",
          version: 1,
          createdAt: "2026-11-13T00:00:00Z",
          renewedAt: null,
          circuits: [{ name: "Ruta", status: "published" }],
        },
      ]),
    );
    expect(await codes.list(TENANT)).toMatchObject([{ code: "7qVtpcGPSWzBExzRe9Bp4w" }]);
    expect(calls[0]?.path).toBe("/rest/v1/rpc/tenant_passport_stamp_codes");
  });

  it("renews with the version and turns the codes into outcomes", async () => {
    const { codes, calls } = session(() => json(2));
    expect(await codes.renew(TENANT, PLAZA, 1)).toEqual({ status: "renewed", version: 2 });
    expect(calls[0]?.body).toEqual({ p_tenant_id: TENANT, p_content_id: PLAZA, p_version: 1 });
    for (const [response, outcome] of [
      [pgError("PT409", 409, "stale"), { status: "stale" }],
      [pgError("42501", 403), { status: "forbidden" }],
      [pgError("P0002", 404), { status: "not_found" }],
    ] as const) {
      expect(await session(() => response.clone()).codes.renew(TENANT, PLAZA, 1)).toEqual(outcome);
    }
  });

  it("before the migration there are none", async () => {
    expect(await session(() => pgError("PGRST202", 404)).codes.list(TENANT)).toEqual([]);
  });
});

describe("stamps (portal)", () => {
  function reader(respond: (path: string, body: unknown) => Response) {
    return createSupabasePublishedStampReader({
      url: BASE,
      publishableKey: "sb_publishable_test",
      fetch: async (input, init = {}) => {
        const url = new URL(String(input));
        return respond(url.pathname, init.body ? JSON.parse(String(init.body)) : null);
      },
    });
  }

  it("reads the place of a code", async () => {
    const place = await reader(() =>
      json({
        id: PLAZA,
        slug: "plaza",
        title: "Plaza",
        summary: "",
        latitude: -17.39,
        longitude: -66.15,
        cover: null,
      }),
    ).place(TENANT, "7qVtpcGPSWzBExzRe9Bp4w");
    expect(place).toMatchObject({ id: PLAZA, location: { lat: -17.39, lng: -66.15 } });
    expect(await reader(() => json(null)).place(TENANT, "x")).toBeNull();
    expect(await reader(() => pgError("PGRST202", 404)).place(TENANT, "x")).toBeNull();
  });

  it("collects a signed stamp, sending only «near»", async () => {
    const sent: unknown[] = [];
    const stamp = await reader((path, body) => {
      sent.push({ path, body });
      return json({
        id: PLAZA,
        slug: "plaza",
        title: "Plaza",
        at: 1_800_000_000,
        located: true,
        signature: "a".repeat(43),
      });
    }).collect(TENANT, "7qVtpcGPSWzBExzRe9Bp4w", "AbCdEfGhIjKlMnOpQrSt_-", true);
    expect(stamp).toEqual({
      placeId: PLAZA,
      slug: "plaza",
      title: "Plaza",
      at: 1_800_000_000,
      located: true,
      signature: "a".repeat(43),
    });
    expect(sent).toEqual([
      {
        path: "/rest/v1/rpc/portal_collect_stamp",
        body: {
          p_tenant_id: TENANT,
          p_code: "7qVtpcGPSWzBExzRe9Bp4w",
          p_passport: "AbCdEfGhIjKlMnOpQrSt_-",
          p_located: true,
        },
      },
    ]);
    expect(await reader(() => json(null)).collect(TENANT, "x", "y", false)).toBeNull();
  });
});
