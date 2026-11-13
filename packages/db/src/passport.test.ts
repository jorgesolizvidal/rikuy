import { describe, expect, it } from "vitest";

import { createPassportRepository, createSupabasePublishedPassportReader } from "./passport";
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
  return { repo: createPassportRepository(client), calls };
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
  });
});
