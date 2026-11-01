import { describe, expect, it } from "vitest";

import { QUOTA_DEFAULTS, type UsageView } from "../../contracts/usage";
import { requestModelUpload } from "../media/models";
import type { MediaRepository } from "../media/ports";
import {
  changeQuota,
  loadUsage,
  meter,
  parseQuotaInput,
  type PlatformUsageRepository,
} from "./usage";

const MB = 1024 * 1024;
const storage = (
  consumed: number,
  reserved = 0,
  limit = QUOTA_DEFAULTS.storage_bytes,
): UsageView => ({
  resource: "storage_bytes",
  limit,
  reserved,
  consumed,
  periodStart: null,
  periodEnd: null,
});

describe("quotas (P2 · Paso 5)", () => {
  it("defaults to 300 MB, 30 min of media compute per month and 40,000 AI tokens per day", () => {
    expect(QUOTA_DEFAULTS).toEqual({
      storage_bytes: 300 * MB,
      media_compute_seconds: 1800,
      ai_tokens: 40_000,
    });
  });

  it("counts what is in progress and warns from 80 %", () => {
    expect(meter(storage(100 * MB, 50 * MB))).toMatchObject({ level: "ok", available: 150 * MB });
    expect(meter(storage(200 * MB, 40 * MB))).toMatchObject({ level: "near", share: 0.8 });
    expect(meter(storage(310 * MB))).toMatchObject({ level: "full", available: 0 });
    expect(meter(storage(1, 0, 0))).toMatchObject({ level: "full", available: 0 });
    expect(meter(storage(0, 0, 0)).level).toBe("ok");
  });

  it("reads limits in megabytes and minutes", () => {
    expect(parseQuotaInput("storage_bytes", "300")).toEqual({
      resource: "storage_bytes",
      limit: 300 * MB,
    });
    expect(parseQuotaInput("storage_bytes", "1,5")).toEqual({
      resource: "storage_bytes",
      limit: 1.5 * MB,
    });
    expect(parseQuotaInput("media_compute_seconds", "30")).toEqual({
      resource: "media_compute_seconds",
      limit: 1800,
    });
    expect(parseQuotaInput("media_compute_seconds", "0")).toEqual({
      resource: "media_compute_seconds",
      limit: 0,
    });
    expect(parseQuotaInput("ai_tokens", "40")).toEqual({ resource: "ai_tokens", limit: 40_000 });
    expect(parseQuotaInput("ai_tokens", "12,5")).toEqual({ resource: "ai_tokens", limit: 12_500 });
    expect(parseQuotaInput("ai_tokens", "10001")).toBeNull();
    for (const bad of ["-1", "abc", "", "1e9", "99999999"])
      expect(parseQuotaInput("storage_bytes", bad)).toBeNull();
    expect(parseQuotaInput("ai_cost", "10")).toBeNull();
  });

  it("changes a quota only with valid input", async () => {
    const calls: string[] = [];
    const platform: PlatformUsageRepository = {
      list: async () => [],
      setQuota: async (tenant, resource, limit) => {
        calls.push(`${tenant}:${resource}:${limit}`);
        return "changed";
      },
    };
    const tenantId = "5eed1000-0000-4000-8000-000000000001";
    expect(await changeQuota({ tenantId, resource: "storage_bytes", value: "500" }, platform)).toBe(
      "changed",
    );
    expect(
      await changeQuota({ tenantId: "x", resource: "storage_bytes", value: "500" }, platform),
    ).toBe("not_found");
    expect(await changeQuota({ tenantId, resource: "storage_bytes", value: "-5" }, platform)).toBe(
      "invalid",
    );
    expect(calls).toEqual([`${tenantId}:storage_bytes:${500 * MB}`]);
  });

  it("lists storage first, then compute", async () => {
    const membership = {
      tenantId: "t",
      slug: "t",
      displayName: "T",
      role: "analyst" as const,
      tenantStatus: "active" as const,
    };
    const compute: UsageView = {
      resource: "media_compute_seconds",
      limit: 1800,
      reserved: 240,
      consumed: 90,
      periodStart: "2026-10-01T04:00:00Z",
      periodEnd: "2026-11-01T04:00:00Z",
    };
    const meters = await loadUsage(membership, { tenantUsage: async () => [compute, storage(10)] });
    expect(meters.map((m) => m.resource)).toEqual(["storage_bytes", "media_compute_seconds"]);
  });

  it("tells the uploader which quota is full", async () => {
    const media = {
      createImageUpload: async () => ({
        status: "over_quota" as const,
        resource: "storage_bytes" as const,
      }),
    } as unknown as MediaRepository;
    const editor = {
      tenantId: "t",
      slug: "t",
      displayName: "T",
      role: "editor" as const,
      tenantStatus: "active" as const,
    };
    expect(
      await requestModelUpload(editor, { mime: "model/gltf-binary", bytes: 10 }, media),
    ).toEqual({
      status: "over_quota",
      resource: "storage_bytes",
    });
  });
});
