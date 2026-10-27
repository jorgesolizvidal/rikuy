import { describe, expect, it } from "vitest";

import type { PublishedTour } from "../../contracts/tour";
import { neighbourScenes, startingScene } from "../../domain/tours/viewer";
import { buildSitemap, tourPath } from "../content/portal";
import { tourViewerModel } from "./portal-view";

const T = "5eed1000-0000-4000-8000-000000000001";
const A = "80000000-0000-4000-8000-0000000000a1";
const B = "80000000-0000-4000-8000-0000000000a2";
const C = "80000000-0000-4000-8000-0000000000a3";
const PLAZA = "80000000-0000-4000-8000-0000000000c1";
const HIDDEN = "80000000-0000-4000-8000-0000000000c2";

const file = (name: string, width: number) => ({
  file: name,
  width,
  height: width / 2,
  bytes: 1,
});
const hotspot = (id: string, extra: Record<string, unknown>) => ({
  hotspotId: `80000000-0000-4000-8000-0000000000${id}`,
  position: { yaw: 1, pitch: -0.2 },
  title: `Punto ${id}`,
  body: [],
  gallery: [],
  targetSceneId: null,
  model: null,
  targetContentId: null,
  ...extra,
});
const scene = (id: string, title: string, tiles: boolean, hotspots: unknown[]) => ({
  sceneId: id,
  title,
  description: "",
  initialView: { yaw: 0, pitch: 0, fov: 70 },
  panorama: {
    folder: `${T}/${id}/1/panorama/`,
    width: tiles ? 8192 : 4096,
    height: tiles ? 4096 : 2048,
    preview: file("preview.webp", 1024),
    image: file("image.webp", 4096),
    tiles: tiles
      ? {
          tileSize: 512,
          format: "webp",
          levels: [
            { width: 8192, height: 4096, cols: 16, rows: 8, dir: "tiles/2" },
            { width: 2048, height: 1024, cols: 4, rows: 2, dir: "tiles/0" },
            { width: 4096, height: 2048, cols: 8, rows: 4, dir: "tiles/1" },
          ],
        }
      : null,
  },
  hotspots,
});

const tour = {
  kind: "destination",
  slug: "museo",
  title: "Museo",
  revisionNo: 3,
  publishedAt: "2026-10-26T12:00:00Z",
  ended: false,
  targets: { [PLAZA]: { kind: "destination", slug: "plaza", title: "Plaza" } },
  manifest: {
    version: 1,
    revisionNo: 3,
    entrySceneId: B,
    scenes: [
      scene(A, "Patio", false, [
        hotspot("f1", {
          kind: "info",
          gallery: [{ assetId: A, version: 1, alt: "Arado", width: 800, height: 600 }],
        }),
        hotspot("f2", { kind: "scene", targetSceneId: B }),
        hotspot("f3", { kind: "tour", targetContentId: PLAZA }),
        hotspot("f4", { kind: "tour", targetContentId: HIDDEN }),
      ]),
      scene(B, "Sala", true, [
        hotspot("f5", {
          kind: "model",
          body: [{ type: "paragraph", children: [{ type: "text", text: "Horno de adobe." }] }],
          model: {
            folder: `${T}/m/1/model/`,
            file: "model.glb",
            bytes: 900,
            weight: "heavy",
            poster: file("poster.webp", 1280),
          },
        }),
        hotspot("f6", { kind: "scene", targetSceneId: "80000000-0000-4000-8000-0000000000ff" }),
      ]),
      scene(C, "Taller", false, []),
    ],
  },
} as unknown as PublishedTour;

describe("the public tour viewer's model", () => {
  const model = tourViewerModel(tour);

  it("keeps the published order and turns files into storage paths", () => {
    expect(model.scenes.map((s) => s.title)).toEqual(["Patio", "Sala", "Taller"]);
    expect(model.scenes[0]?.panorama).toEqual({
      preview: `${T}/${A}/1/panorama/preview.webp`,
      image: { path: `${T}/${A}/1/panorama/image.webp`, width: 4096, height: 2048 },
      tiles: null,
    });
    // Levels smallest first, whatever order the manifest kept.
    expect(model.scenes[1]?.panorama.tiles?.levels.map((level) => level.dir)).toEqual([
      "tiles/0",
      "tiles/1",
      "tiles/2",
    ]);
  });

  it("leaves out a tile level the viewer cannot use (not a power of two of columns)", () => {
    const odd = structuredClone(tour) as unknown as {
      manifest: { scenes: { panorama: { tiles: { levels: unknown[] } | null } }[] };
    };
    const b = odd.manifest.scenes[1]?.panorama.tiles;
    if (!b) throw new Error("fixture without tiles");
    b.levels = [
      { width: 2048, height: 1024, cols: 4, rows: 2, dir: "tiles/0" },
      { width: 4096, height: 2048, cols: 8, rows: 4, dir: "tiles/1" },
      { width: 5120, height: 2560, cols: 10, rows: 5, dir: "tiles/2" },
    ];
    const levels = tourViewerModel(odd as unknown as PublishedTour).scenes[1]?.panorama.tiles
      ?.levels;
    expect(levels?.map((level) => level.width)).toEqual([2048, 4096]);
  });

  it("resolves the points a visitor can use and leaves out the rest", () => {
    const [patio, sala] = model.scenes;
    expect(patio?.points.map((point) => point.kind)).toEqual(["info", "scene", "tour"]);
    expect(patio?.points[1]).toMatchObject({ targetSceneId: B, targetTitle: "Sala" });
    expect(patio?.points[2]).toMatchObject({
      target: { slug: "plaza", title: "Plaza", href: "/destinos/plaza/tour" },
    });
    // A model keeps its poster and its description; a scene not in this revision is dropped.
    expect(sala?.points).toEqual([
      expect.objectContaining({
        kind: "model",
        body: [{ type: "paragraph", children: [{ type: "text", text: "Horno de adobe." }] }],
        poster: { path: `${T}/m/1/model/poster.webp`, width: 1280, height: 640 },
        model: { path: `${T}/m/1/model/model.glb`, bytes: 900, heavy: true },
      }),
    ]);
  });

  it("starts at the scene a link asks for, else at the entry", () => {
    expect(startingScene(model, C).title).toBe("Taller");
    expect(startingScene(model, null).title).toBe("Sala");
    expect(startingScene(model, "not-a-scene").title).toBe("Sala");
  });

  it("knows the scene before and after", () => {
    expect(neighbourScenes(model, A)).toEqual({ previous: null, next: model.scenes[1] });
    expect(neighbourScenes(model, C).next).toBeNull();
    expect(neighbourScenes(model, "unknown")).toEqual({ previous: null, next: null });
  });
});

describe("tour pages in the portal", () => {
  it("has one page per destination or event tour, and they are in the sitemap", () => {
    expect(tourPath("destination", "museo")).toBe("/destinos/museo/tour");
    expect(tourPath("event", "feria del maíz")).toBe("/agenda/feria%20del%20ma%C3%ADz/tour");
    const xml = buildSitemap(
      "https://demo.example",
      [],
      [],
      [{ kind: "destination", slug: "museo", publishedAt: "2026-10-26T12:00:00Z" }],
    );
    expect(xml).toContain(
      "<url><loc>https://demo.example/destinos/museo/tour</loc><lastmod>2026-10-26T12:00:00.000Z</lastmod></url>",
    );
  });
});
