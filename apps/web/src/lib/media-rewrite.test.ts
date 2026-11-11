import { PORTAL_MEDIA_PREFIX, portalMediaPath } from "@rikuy/core";
import { MEDIA_BUCKETS, publicMediaUrl } from "@rikuy/db";
import { describe, expect, it } from "vitest";

import { mediaRewrite, PUBLIC_MEDIA_BUCKET } from "./media-rewrite";

const PATH =
  "5eed1000-0000-4000-8000-000000000001/5eed3000-0000-4000-8000-000000000001/1/w960.webp";

/** What the CDN fetches for a portal media URL, applying the rewrite like Next.js does. */
function forwarded(supabaseUrl: string, portalPath: string): string {
  const [rule] = mediaRewrite(supabaseUrl);
  if (!rule) throw new Error("no rewrite");
  const prefix = rule.source.replace(":path*", "");
  expect(portalPath.startsWith(prefix)).toBe(true);
  return rule.destination.replace(":path*", portalPath.slice(prefix.length));
}

describe("media from the portal's own address (ADR-050)", () => {
  it("forwards to the same public URL Storage serves", () => {
    for (const url of ["https://ref.supabase.co", "http://127.0.0.1:54321/"]) {
      expect(forwarded(url, portalMediaPath(PATH))).toBe(publicMediaUrl(url, PATH));
    }
  });

  it("uses the public bucket and the portal's media prefix", () => {
    expect(PUBLIC_MEDIA_BUCKET).toBe(MEDIA_BUCKETS.public);
    expect(mediaRewrite("https://ref.supabase.co")[0]?.source).toBe(
      `${PORTAL_MEDIA_PREFIX}/:path*`,
    );
  });

  it("forwards nothing without a Storage address", () => {
    expect(mediaRewrite(undefined)).toEqual([]);
  });
});
