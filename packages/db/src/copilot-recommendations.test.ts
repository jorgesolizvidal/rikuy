import { describe, expect, it } from "vitest";

import { createRecommendationsRepository } from "./copilot-recommendations";
import type { SessionClient } from "./session-client";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const MUSEO = "5eed2000-0000-4000-8000-000000000001";
const ID = "5eed3000-0000-4000-8000-000000000001";

function client(result: {
  data?: unknown;
  error?: { code: string; hint?: string } | null;
  status?: number;
}) {
  const calls: { fn: string; args: unknown }[] = [];
  const session = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return {
        data: result.data ?? null,
        error: result.error ?? null,
        status: result.status ?? 200,
      };
    },
  } as unknown as SessionClient;
  return { session, calls };
}

const SAVED = {
  id: ID,
  createdAt: "2026-11-12T20:00:00+00:00",
  from: "2026-10-14",
  to: "2026-11-12",
  facts: [
    {
      id: "H1",
      source: "visits",
      text: "Museo: 15 vistas.",
      target: { type: "content", kind: "destination", contentId: MUSEO, proposable: true },
    },
    {
      id: "H2",
      source: "agenda",
      text: "Sin eventos.",
      target: { type: "calendar-of-the-future" },
    },
    { id: "H3", source: "weather", text: "Llueve.", target: null },
  ],
  items: [{ title: "Mira el museo", why: "Tuvo 15 vistas.", facts: ["H1"] }],
  mine: true,
};

describe("recommendations adapter", () => {
  it("reads the latest set; an unknown target becomes none and an unknown source is dropped", async () => {
    const { session, calls } = client({ data: SAVED });
    const saved = await createRecommendationsRepository(session).latest(TENANT);
    expect(calls).toEqual([
      { fn: "latest_copilot_recommendations", args: { p_tenant_id: TENANT } },
    ]);
    expect(saved?.facts.map((fact) => [fact.id, fact.target?.type ?? null])).toEqual([
      ["H1", "content"],
      ["H2", null],
    ]);
    expect(saved?.items).toHaveLength(1);
  });

  it("reads none: nothing generated yet, or the migration has not arrived", async () => {
    expect(
      await createRecommendationsRepository(client({ data: null }).session).latest(TENANT),
    ).toBeNull();
    expect(
      await createRecommendationsRepository(client({ error: { code: "PGRST202" } }).session).latest(
        TENANT,
      ),
    ).toBeNull();
    await expect(
      createRecommendationsRepository(client({ error: { code: "XX000" } }).session).latest(TENANT),
    ).rejects.toThrow("(XX000)");
  });

  it("saves with the RPC and turns the database's refusals into outcomes", async () => {
    const { session, calls } = client({ data: ID });
    const input = {
      tenantId: TENANT,
      aiRequestId: "cccccccc-0000-4000-8000-000000000001",
      from: "2026-10-14",
      to: "2026-11-12",
      facts: [],
      items: [],
    };
    expect(await createRecommendationsRepository(session).save(input)).toEqual({
      status: "saved",
      id: ID,
    });
    expect(calls[0]).toEqual({
      fn: "save_copilot_recommendations",
      args: {
        p_tenant_id: TENANT,
        p_ai_request_id: input.aiRequestId,
        p_period_from: "2026-10-14",
        p_period_to: "2026-11-12",
        p_facts: [],
        p_items: [],
      },
    });
    for (const [error, status, expected] of [
      [{ code: "42501" }, 403, "forbidden"],
      [{ code: "23514", hint: "numbers" }, 400, "invalid"],
      [{ code: "22023" }, 400, "invalid"],
      [{ code: "PGRST202" }, 404, "invalid"],
    ] as const) {
      expect(
        await createRecommendationsRepository(client({ error, status }).session).save(input),
      ).toEqual({ status: expected });
    }
  });
});
