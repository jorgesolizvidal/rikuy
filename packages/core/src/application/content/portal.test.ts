import { describe, expect, it } from "vitest";

import type {
  PortalMapPlace,
  PublishedDestination,
  PublishedDestinationReader,
  PublishedMapReader,
} from "./ports";
import {
  PORTAL_PATHS,
  buildRobotsTxt,
  buildSitemap,
  createCachedPublishedDestinationReader,
  createCachedPublishedMapReader,
  mapPlacePath,
  destinationJsonLd,
  directionsUrl,
  imageCandidates,
  openStreetMapUrl,
  serializeJsonLd,
} from "./portal";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ASSET = "5eed3000-0000-4000-8000-000000000001";

const destination: PublishedDestination = {
  slug: "mirador-del-valle",
  revisionNo: 2,
  title: "Mirador </script> del Valle",
  summary: "",
  body: [{ type: "paragraph", children: [{ type: "text", text: "Vista al valle." }] }],
  location: { lat: -17.39, lng: -66.15 },
  cover: null,
  gallery: [],
  publishedAt: "2026-10-18T00:00:00Z",
  updatedAt: "2026-10-18T01:00:00Z",
};

describe("responsive image candidates", () => {
  it("lists the three widths for a large original, with proportional heights", () => {
    const candidates = imageCandidates(TENANT, {
      assetId: ASSET,
      version: 1,
      alt: "x",
      width: 4000,
      height: 3000,
    });
    expect(candidates).toEqual([
      { path: `${TENANT}/${ASSET}/1/w480.webp`, width: 480, height: 360 },
      { path: `${TENANT}/${ASSET}/1/w960.webp`, width: 960, height: 720 },
      { path: `${TENANT}/${ASSET}/1/w1600.webp`, width: 1600, height: 1200 },
    ]);
  });

  it("never claims a width larger than the original (derivatives are not enlarged)", () => {
    const candidates = imageCandidates(TENANT, {
      assetId: ASSET,
      version: 3,
      alt: "x",
      width: 800,
      height: 600,
    });
    expect(candidates.map((c) => [c.path.split("/").at(-1), c.width])).toEqual([
      ["w480.webp", 480],
      ["w960.webp", 800],
    ]);
  });
});

describe("portal links and metadata", () => {
  it("builds directions and OpenStreetMap links from coordinates", () => {
    expect(directionsUrl({ lat: -17.39, lng: -66.15 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=-17.39,-66.15",
    );
    expect(openStreetMapUrl({ lat: -17.39, lng: -66.15 })).toContain("mlat=-17.39&mlon=-66.15");
  });

  it("describes the destination as a TouristAttraction with coordinates", () => {
    const data = destinationJsonLd(destination, {
      url: "https://demo.example/destinos/mirador-del-valle",
      imageUrl: null,
      portalName: "Demo",
    });
    expect(data).toMatchObject({
      "@type": "TouristAttraction",
      description: "Vista al valle.",
      geo: { "@type": "GeoCoordinates", latitude: -17.39, longitude: -66.15 },
    });
    expect(data).not.toHaveProperty("image");
  });

  it("serializes JSON-LD so it can never close the script tag", () => {
    const json = serializeJsonLd(
      destinationJsonLd(destination, { url: "https://x.test", imageUrl: null, portalName: "D" }),
    );
    expect(json).not.toContain("</script>");
    expect(JSON.parse(json).name).toBe("Mirador </script> del Valle");
  });

  it("lists home, destinations, each destination and legal pages in the sitemap", () => {
    const xml = buildSitemap("https://demo.example", [
      { ...destination, slug: "a&b" },
      { ...destination, slug: "laguna", updatedAt: "2026-10-19T00:00:00Z" },
    ]);
    expect(xml).toContain("<loc>https://demo.example/</loc><lastmod>2026-10-19T00:00:00.000Z");
    expect(xml).toContain("<loc>https://demo.example/destinos/a%26b</loc>");
    expect(xml).toContain("<loc>https://demo.example/destinos/laguna</loc>");
    expect(xml).toContain(`<loc>https://demo.example${PORTAL_PATHS.privacy}</loc>`);
    expect(buildRobotsTxt("https://demo.example")).toContain(
      "Sitemap: https://demo.example/sitemap.xml",
    );
  });
});

describe("cached published destination reader", () => {
  function counting() {
    const calls: string[] = [];
    let fail = false;
    const inner: PublishedDestinationReader = {
      async list(tenantId) {
        calls.push(`list:${tenantId}`);
        if (fail) throw new Error("down");
        return [];
      },
      async find(tenantId, slug) {
        calls.push(`find:${tenantId}:${slug}`);
        return slug === destination.slug ? destination : null;
      },
    };
    return { inner, calls, setFail: (value: boolean) => (fail = value) };
  }

  it("shares concurrent reads and refreshes after the TTL, per tenant and slug", async () => {
    let now = 0;
    const { inner, calls } = counting();
    const reader = createCachedPublishedDestinationReader(inner, { ttlMs: 1000, now: () => now });
    await Promise.all([reader.list("a"), reader.list("a"), reader.list("b")]);
    await reader.find("a", destination.slug);
    await reader.find("a", "otro");
    await reader.find("a", destination.slug);
    expect(calls).toEqual(["list:a", "list:b", `find:a:${destination.slug}`, "find:a:otro"]);
    now = 1001;
    await reader.list("a");
    expect(calls.at(-1)).toBe("list:a");
    expect(calls).toHaveLength(5);
  });

  it("does not cache failures", async () => {
    const { inner, calls, setFail } = counting();
    const reader = createCachedPublishedDestinationReader(inner);
    setFail(true);
    await expect(reader.list("a")).rejects.toThrow("down");
    setFail(false);
    await expect(reader.list("a")).resolves.toEqual([]);
    expect(calls).toEqual(["list:a", "list:a"]);
  });
});

describe("cached map reader", () => {
  const place = (slug: string, lat: number, lng: number): PortalMapPlace => ({
    kind: "destination",
    slug,
    title: slug,
    summary: "",
    location: { lat, lng },
    schedule: null,
    cover: null,
  });

  it("asks once per snapped area and trims results back to the requested one", async () => {
    const asked: string[] = [];
    const inner: PublishedMapReader = {
      extent: async () => ({ bounds: null, destinations: 0, events: 0 }),
      async places(_tenant, area, kinds) {
        asked.push(`${area.west},${area.south},${area.east},${area.north}:${kinds.join("+")}`);
        return [place("dentro", -17.385, -66.145), place("borde", -17.399, -66.159)];
      },
    };
    const reader = createCachedPublishedMapReader(inner);
    const first = await reader.places(
      "t",
      { west: -66.151, south: -17.391, east: -66.14, north: -17.38 },
      ["event", "destination"],
    );
    const second = await reader.places(
      "t",
      { west: -66.152, south: -17.392, east: -66.141, north: -17.381 },
      ["destination", "event"],
    );
    expect(first.map((p) => p.slug)).toEqual(["dentro"]);
    expect(second.map((p) => p.slug)).toEqual(["dentro"]);
    expect(asked).toEqual(["-66.16,-17.4,-66.14,-17.38:destination+event"]);
  });

  it("links each place to its page", () => {
    expect(mapPlacePath({ kind: "event", slug: "feria" })).toBe("/agenda/feria");
    expect(mapPlacePath({ kind: "destination", slug: "plaza" })).toBe("/destinos/plaza");
  });
});
