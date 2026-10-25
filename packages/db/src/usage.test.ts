import { describe, expect, it } from "vitest";

import { createMediaRepository } from "./media";
import type { SessionClient } from "./session-client";
import { createPlatformUsageRepository, createUsageRepository } from "./usage";

function client(result: { data?: unknown; error?: { code: string; hint?: string } | null }) {
  return {
    rpc: async () => ({ data: result.data ?? null, error: result.error ?? null }),
  } as unknown as SessionClient;
}

describe("usage adapters", () => {
  it("maps the municipality's usage, with no period for storage", async () => {
    const rows = [
      {
        resource: "storage_bytes",
        limit_amount: 314572800,
        reserved: "1000",
        consumed: 52200000,
        period_start: "-infinity",
        period_end: "infinity",
      },
      {
        resource: "media_compute_seconds",
        limit_amount: 1800,
        reserved: 240,
        consumed: 91,
        period_start: "2026-10-01T04:00:00+00:00",
        period_end: "2026-11-01T04:00:00+00:00",
      },
    ];
    expect(await createUsageRepository(client({ data: rows })).tenantUsage("t")).toEqual([
      {
        resource: "storage_bytes",
        limit: 314572800,
        reserved: 1000,
        consumed: 52200000,
        periodStart: null,
        periodEnd: null,
      },
      {
        resource: "media_compute_seconds",
        limit: 1800,
        reserved: 240,
        consumed: 91,
        periodStart: "2026-10-01T04:00:00.000Z",
        periodEnd: "2026-11-01T04:00:00.000Z",
      },
    ]);
  });

  it("tells which quota refused an upload", async () => {
    for (const [hint, resource] of [
      ["storage_bytes", "storage_bytes"],
      ["media_compute_seconds", "media_compute_seconds"],
    ] as const) {
      const media = createMediaRepository(client({ error: { code: "PT507", hint } }));
      expect(await media.createImageUpload("t", "model", "model/gltf-binary", 10)).toEqual({
        status: "over_quota",
        resource,
      });
    }
  });

  it("maps the operator's outcomes", async () => {
    expect(await createPlatformUsageRepository(client({})).setQuota("t", "storage_bytes", 1)).toBe(
      "changed",
    );
    expect(
      await createPlatformUsageRepository(client({ error: { code: "42501" } })).setQuota(
        "t",
        "storage_bytes",
        1,
      ),
    ).toBe("forbidden");
    expect(
      await createPlatformUsageRepository(client({ error: { code: "23514" } })).setQuota(
        "t",
        "storage_bytes",
        -1,
      ),
    ).toBe("invalid");
  });
});
