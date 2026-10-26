import { describe, expect, it, vi } from "vitest";

import { tourManifestSchema, type TourRecord, type TourRevision } from "../../contracts/tour";
import { publishTourMedia, tourMediaPlan } from "./publication";
import { publishTour, type TourRepository } from "./tours";

const owner = {
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "t",
  displayName: "T",
  role: "owner" as const,
  tenantStatus: "active" as const,
};
const TOUR = "70000000-0000-4000-8000-000000000001";
const SCENE = "70000000-0000-4000-8000-0000000000a1";
const PANO = "70000000-0000-4000-8000-0000000000b1";
const PANO2 = "70000000-0000-4000-8000-0000000000b2";
const MODEL = "70000000-0000-4000-8000-0000000000c1";
const PHOTO = "70000000-0000-4000-8000-0000000000d1";

const panoramaManifest = (tiles: boolean) => ({
  version: 1 as const,
  projection: "equirectangular" as const,
  source: {
    width: 8192,
    height: 4096,
    bytes: 1,
    mime: "image/jpeg" as const,
    sha256: "a".repeat(64),
  },
  preview: { file: "preview.webp", width: 1024, height: 512, bytes: 1 },
  image: { file: "image.webp", width: 4096, height: 2048, bytes: 1 },
  tiles: tiles
    ? {
        tileSize: 512 as const,
        format: "webp" as const,
        levels: [
          { width: 2048, height: 1024, cols: 4, rows: 2, dir: "tiles/0" },
          { width: 4096, height: 2048, cols: 8, rows: 4, dir: "tiles/1" },
        ],
      }
    : null,
});

const modelManifest = {
  poster: { file: "poster.webp", width: 1280, height: 960, bytes: 1 },
  model: { file: "model.glb" },
} as never;

function revision(options: { published?: boolean; editCount?: number } = {}): TourRevision {
  return {
    revisionId: "70000000-0000-4000-8000-0000000000e1",
    revisionNo: 2,
    state: "draft",
    editCount: options.editCount ?? 4,
    entrySceneId: SCENE,
    updatedAt: "",
    sealedAt: null,
    scenes: [
      {
        sceneId: SCENE,
        position: 0,
        title: "Sala",
        description: "",
        initialView: { yaw: 0, pitch: 0, fov: 60 },
        panorama: {
          versionId: PANO,
          assetId: PANO,
          version: 1,
          width: 8192,
          height: 4096,
          manifest: panoramaManifest(true),
          published: options.published ?? false,
        },
        hotspots: [
          {
            hotspotId: "70000000-0000-4000-8000-0000000000f1",
            kind: "model",
            position: { yaw: 0, pitch: 0 },
            title: "Horno",
            body: [],
            gallery: [],
            targetSceneId: null,
            target: null,
            model: {
              versionId: MODEL,
              assetId: MODEL,
              version: 1,
              manifest: modelManifest,
              published: false,
            },
          },
          {
            hotspotId: "70000000-0000-4000-8000-0000000000f2",
            kind: "info",
            position: { yaw: 1, pitch: 0 },
            title: "Arado",
            body: [],
            gallery: [{ assetId: PHOTO, version: 2, alt: "El arado" }],
            targetSceneId: null,
            target: null,
            model: null,
          },
        ],
      },
      {
        sceneId: "70000000-0000-4000-8000-0000000000a2",
        position: 1,
        title: "Patio",
        description: "",
        initialView: { yaw: 0, pitch: 0, fov: 60 },
        panorama: {
          versionId: PANO2,
          assetId: PANO2,
          version: 3,
          width: 4096,
          height: 2048,
          manifest: panoramaManifest(false),
          published: true,
        },
        hotspots: [],
      },
    ],
  };
}

describe("tour media plan", () => {
  it("lists every tile of the panoramas that are not public yet, models with their poster and the photos", () => {
    const plan = tourMediaPlan(revision());
    const pano = plan.files.find((entry) => entry.assetId === PANO);
    expect(pano?.files).toHaveLength(2 + 4 * 2 + 8 * 4);
    expect(pano?.files.slice(0, 3)).toEqual([
      "panorama/preview.webp",
      "panorama/image.webp",
      "panorama/tiles/0/0_0.webp",
    ]);
    expect(pano?.files).toContain("panorama/tiles/1/7_3.webp");
    expect(plan.files.find((entry) => entry.assetId === MODEL)?.files).toEqual([
      "model/model.glb",
      "model/poster.webp",
    ]);
    expect(plan.files.some((entry) => entry.assetId === PANO2)).toBe(false);
    expect(plan.photos).toEqual([{ assetId: PHOTO, version: 2 }]);
  });

  it("copies the files, then the photos", async () => {
    const calls: string[] = [];
    const admin = {
      publishFiles: vi.fn(
        async (_t: string, asset: string, _v: number, files: readonly string[]) => {
          calls.push(`files:${asset}:${files.length}`);
        },
      ),
      publish: vi.fn(async (_t: string, asset: string) => {
        calls.push(`photo:${asset}`);
      }),
    };
    expect(await publishTourMedia(owner.tenantId, tourMediaPlan(revision()), admin)).toBe(42 + 2);
    expect(calls).toEqual([`files:${PANO}:42`, `files:${MODEL}:2`, `photo:${PHOTO}`]);
  });
});

describe("publishing a tour", () => {
  function deps(record: TourRecord | null) {
    return {
      tours: {
        find: vi.fn(async () => record),
        publish: vi.fn(async () => ({ status: "published" as const, revisionNo: 2 })),
      } satisfies Pick<TourRepository, "find" | "publish">,
      media: { publish: vi.fn(async () => undefined), publishFiles: vi.fn(async () => undefined) },
    };
  }
  const record = (draft: TourRevision | null): TourRecord => ({
    tourId: TOUR,
    content: {
      contentId: PHOTO,
      kind: "destination",
      slug: "museo",
      title: "Museo",
      published: true,
    },
    draft,
    published: null,
    history: [],
  });

  it("copies the media before sealing", async () => {
    const d = deps(record(revision()));
    expect(await publishTour(owner, { tourId: TOUR, expectedEdit: 4 }, d)).toEqual({
      status: "published",
      revisionNo: 2,
    });
    expect(d.media.publishFiles).toHaveBeenCalledTimes(2);
    expect(d.media.publishFiles.mock.invocationCallOrder[0]).toBeLessThan(
      d.tours.publish.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("copies nothing for an old edit number, a missing poster or no draft", async () => {
    for (const [draft, expected, status] of [
      [revision({ editCount: 5 }), 4, "conflict"],
      [null, 4, "conflict"],
    ] as const) {
      const d = deps(record(draft));
      expect(await publishTour(owner, { tourId: TOUR, expectedEdit: expected }, d)).toEqual({
        status,
      });
      expect(d.media.publishFiles).not.toHaveBeenCalled();
    }
    const withoutPoster = revision();
    const model = withoutPoster.scenes[0]?.hotspots[0]?.model;
    if (model) Object.assign(model, { manifest: null });
    const d = deps(record(withoutPoster));
    expect(await publishTour(owner, { tourId: TOUR, expectedEdit: 4 }, d)).toEqual({
      status: "poster",
    });
    expect(d.media.publishFiles).not.toHaveBeenCalled();
  });
});

describe("tour manifest", () => {
  it("reads the public snapshot of a sealed revision", () => {
    const parsed = tourManifestSchema.parse({
      version: 1,
      revisionNo: 1,
      entrySceneId: SCENE,
      scenes: [
        {
          sceneId: SCENE,
          title: "Sala",
          description: "",
          initialView: { yaw: 0, pitch: 0, fov: 60 },
          panorama: {
            folder: `${owner.tenantId}/${PANO}/1/panorama/`,
            width: 8192,
            height: 4096,
            preview: { file: "preview.webp", width: 1024, height: 512, bytes: 1 },
            image: { file: "image.webp", width: 4096, height: 2048, bytes: 1 },
            tiles: null,
          },
          hotspots: [
            {
              hotspotId: "70000000-0000-4000-8000-0000000000f3",
              kind: "tour",
              position: { yaw: 2, pitch: 0 },
              title: "Ir a la plaza",
              body: [],
              gallery: [],
              targetSceneId: null,
              model: null,
              targetContentId: PHOTO,
            },
          ],
        },
      ],
    });
    expect(parsed.scenes[0]?.hotspots[0]?.targetContentId).toBe(PHOTO);
  });
});
