import { describe, expect, it } from "vitest";

import type { SessionClient } from "./session-client";
import { createStatisticsRepository } from "./statistics";

const MUSEO = "5eed2000-0000-4000-8000-000000000001";

function client(result: { data?: unknown; error?: { code: string } | null }) {
  const calls: { fn: string; args: unknown }[] = [];
  const session = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return { data: result.data ?? null, error: result.error ?? null };
    },
  } as unknown as SessionClient;
  return { session, calls };
}

describe("statistics adapter", () => {
  it("reads the calendar of the municipality", async () => {
    const { session, calls } = client({
      data: [{ timezone: "America/La_Paz", first_day: "2026-11-12" }],
    });
    expect(await createStatisticsRepository(session).calendar("t")).toEqual({
      timezone: "America/La_Paz",
      firstDay: "2026-11-12",
    });
    expect(calls).toEqual([{ fn: "tenant_visit_calendar", args: { p_tenant_id: "t" } }]);
  });

  it("reads a period, with counts that may come as text", async () => {
    const { session, calls } = client({
      data: {
        from: "2026-11-01",
        to: "2026-11-02",
        items: [
          {
            day: null,
            target: "destination",
            contentId: MUSEO,
            kind: "destination",
            slug: "museo",
            title: "Museo",
            sceneId: null,
            sceneTitle: null,
            event: "qr",
            views: "3",
            visitors: 2,
          },
        ],
        days: [{ day: "2026-11-02", views: 3, visitors: "1" }],
        origins: [{ day: null, country: null, city: null, views: 1, visitors: 1 }],
      },
    });
    const data = await createStatisticsRepository(session).statistics(
      "t",
      { from: "2026-11-01", to: "2026-11-02" },
      true,
    );
    expect(data.items[0]).toMatchObject({ event: "qr", views: 3, visitors: 2 });
    expect(data.days).toEqual([{ day: "2026-11-02", views: 3, visitors: 1 }]);
    expect(calls[0]).toEqual({
      fn: "tenant_visit_statistics",
      args: { p_tenant_id: "t", p_from: "2026-11-01", p_to: "2026-11-02", p_daily: true },
    });
  });

  it("refuses what it does not know", async () => {
    const { session } = client({
      data: {
        from: "2026-11-01",
        to: "2026-11-02",
        items: [{ target: "privacy" }],
        days: [],
        origins: [],
      },
    });
    await expect(
      createStatisticsRepository(session).statistics(
        "t",
        { from: "2026-11-01", to: "2026-11-02" },
        false,
      ),
    ).rejects.toThrow();
  });

  it("shows nothing before the migration, and fails on other errors", async () => {
    const missing = createStatisticsRepository(client({ error: { code: "PGRST202" } }).session);
    expect(await missing.calendar("t")).toEqual({ timezone: "UTC", firstDay: null });
    expect(await missing.statistics("t", { from: "2026-11-01", to: "2026-11-02" }, false)).toEqual({
      from: "2026-11-01",
      to: "2026-11-02",
      items: [],
      days: [],
      origins: [],
    });
    const denied = createStatisticsRepository(client({ error: { code: "42501" } }).session);
    await expect(denied.calendar("t")).rejects.toThrow("42501");
  });

  it("reads the passport of a period, and nothing before the migration", async () => {
    const circuit = "5eed4600-0000-4000-8000-000000000001";
    const { session, calls } = client({
      data: {
        from: "2026-11-01",
        to: "2026-11-02",
        since: "2026-10-30",
        places: [
          {
            day: null,
            contentId: MUSEO,
            slug: "museo",
            title: "Museo",
            stop: true,
            stamps: "4",
            located: 3,
          },
        ],
        circuits: [
          {
            day: null,
            circuitId: circuit,
            slug: "ruta",
            name: "Ruta",
            published: true,
            completed: "2",
            redeemed: 1,
          },
        ],
      },
    });
    const range = { from: "2026-11-01", to: "2026-11-02" };
    const data = await createStatisticsRepository(session).passport("t", range, false);
    expect(data?.places[0]).toMatchObject({ stamps: 4, located: 3, stop: true });
    expect(data?.circuits[0]).toMatchObject({ completed: 2, redeemed: 1 });
    expect(calls[0]).toEqual({
      fn: "tenant_passport_statistics",
      args: { p_tenant_id: "t", p_from: "2026-11-01", p_to: "2026-11-02", p_daily: false },
    });
    const missing = createStatisticsRepository(client({ error: { code: "PGRST202" } }).session);
    expect(await missing.passport("t", range, false)).toBeNull();
    const denied = createStatisticsRepository(client({ error: { code: "42501" } }).session);
    await expect(denied.passport("t", range, false)).rejects.toThrow("42501");
  });
});
