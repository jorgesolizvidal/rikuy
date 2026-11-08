import type { ClaimedJob, PortalProbeResult, PortalProbeStore } from "@rikuy/core";
import { describe, expect, it } from "vitest";

import { createProbePortalProcessor, createTimedFetch } from "./probe-portal";

const job = (payload: unknown = {}): ClaimedJob => ({
  jobId: "11111111-1111-4111-8111-111111111111",
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  kind: "metrics.probe_portal",
  schemaVersion: 1,
  payload,
  checkpoint: null,
  generation: 1,
  attemptNo: 1,
  fencingToken: "7",
  leaseSeconds: 60,
  maxActiveSeconds: 90,
});

function store(target: Awaited<ReturnType<PortalProbeStore["target"]>>) {
  const recorded: PortalProbeResult[][] = [];
  const probes: PortalProbeStore = {
    target: async () => target,
    async record(_lease, results) {
      recorded.push([...results]);
      return "recorded";
    },
  };
  return { probes, recorded };
}

const context = (value: ClaimedJob) =>
  ({ job: value }) as unknown as Parameters<
    ReturnType<typeof createProbePortalProcessor>["run"]
  >[0];

describe("metrics.probe_portal", () => {
  const portalProbe = {
    portalOrigin: (host: string) => `https://${host}`,
    publicMediaBase: "https://ref.supabase.co",
  };

  it("times the home, /mapa and an image, and records them", async () => {
    const { probes, recorded } = store({ host: "demo.vercel.app", mediaPath: "t/a/1/w480.webp" });
    const urls: string[] = [];
    const processor = createProbePortalProcessor({
      probes,
      portalProbe: {
        ...portalProbe,
        fetchTimed: async (url) => {
          urls.push(url);
          return { status: 200, ttfbMs: 50, totalMs: 70, bytes: 100, cache: "HIT" };
        },
      },
    });
    expect(await processor.run(context(job()))).toEqual({
      result: { outcome: "probed", ok: 3, total: 3 },
    });
    expect(urls).toEqual([
      "https://demo.vercel.app/",
      "https://demo.vercel.app/mapa",
      "https://ref.supabase.co/storage/v1/object/public/media-public/t/a/1/w480.webp",
    ]);
    expect(recorded[0]?.map((entry) => entry.target)).toEqual(["home", "map", "media"]);
  });

  it("does nothing for a municipality that is not online, and refuses a bad payload", async () => {
    const { probes, recorded } = store(null);
    const processor = createProbePortalProcessor({ probes, portalProbe });
    expect(await processor.run(context(job()))).toEqual({ result: { outcome: "not_online" } });
    expect(recorded).toEqual([]);
    await expect(processor.run(context(job({ host: "evil.test" })))).rejects.toMatchObject({
      code: "invalid_payload",
    });
  });

  it("measures the time to the headers and to the last byte, without following redirects", async () => {
    let init: RequestInit | undefined;
    const timed = createTimedFetch(async (_url, options) => {
      init = options;
      return new Response("hola", { status: 200, headers: { "x-vercel-cache": "hit" } });
    });
    const result = await timed("https://demo.vercel.app/");
    expect(result).toMatchObject({ status: 200, bytes: 4, cache: "HIT" });
    expect(result.totalMs).toBeGreaterThanOrEqual(result.ttfbMs);
    expect(init?.redirect).toBe("manual");
  });
});
