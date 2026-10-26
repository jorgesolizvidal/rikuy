import { describe, expect, it } from "vitest";

import { createSupabaseMediaAdmin } from "./media";

/** A fake Storage + PostgREST that records what the media admin asks for. */
function fakeStack(options: { existing?: readonly string[]; failing?: string } = {}) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname.endsWith("/object/copy")) {
      calls.push(`copy:${body.bucketId}->${body.destinationBucket}:${body.destinationKey}`);
      if (options.failing && body.destinationKey.endsWith(options.failing)) {
        return new Response(JSON.stringify({ statusCode: "500", error: "x", message: "boom" }), {
          status: 500,
        });
      }
      if (options.existing?.some((name) => body.destinationKey.endsWith(name))) {
        return new Response(
          JSON.stringify({
            statusCode: "409",
            error: "Duplicate",
            message: "The resource already exists",
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ Key: `${body.destinationBucket}/${body.destinationKey}` }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/rpc/media_publish_version")) {
      calls.push(`publish:${body.p_asset_id}:${body.p_version}`);
      return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    calls,
    admin: createSupabaseMediaAdmin({
      url: "http://stack.test",
      secretKey: "sb_secret_test",
      fetch,
    }),
  };
}

const T = "5eed1000-0000-4000-8000-000000000001";
const A = "70000000-0000-4000-8000-0000000000b1";

describe("publishing panoramas and models", () => {
  it("copies inside Storage to the public bucket, then marks the version published", async () => {
    const { calls, admin } = fakeStack();
    await admin.publishFiles(T, A, 1, ["panorama/preview.webp", "panorama/tiles/0/0_0.webp"]);
    expect(calls).toEqual([
      `copy:media-originals->media-public:${T}/${A}/1/panorama/preview.webp`,
      `copy:media-originals->media-public:${T}/${A}/1/panorama/tiles/0/0_0.webp`,
      `publish:${A}:1`,
    ]);
  });

  it("counts a file that is already public as copied", async () => {
    const { calls, admin } = fakeStack({ existing: ["preview.webp"] });
    await admin.publishFiles(T, A, 1, ["panorama/preview.webp"]);
    expect(calls.at(-1)).toBe(`publish:${A}:1`);
  });

  it("never marks a version published when a copy fails", async () => {
    const { calls, admin } = fakeStack({ failing: "image.webp" });
    await expect(
      admin.publishFiles(T, A, 1, ["panorama/preview.webp", "panorama/image.webp"]),
    ).rejects.toThrow("Publishing panorama/image.webp failed");
    expect(calls.some((call) => call.startsWith("publish:"))).toBe(false);
  });
});
