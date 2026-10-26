import { describe, expect, it, vi } from "vitest";

import { tourRecordSchema, type TourRecord, type TourRevision } from "../../contracts/tour";
import {
  normalizeSceneView,
  normalizeYaw,
  parseSceneChanges,
  parseSceneTitle,
  tourPublicationIssues,
} from "../../domain/tours/scene";
import type { PanoramaView } from "../media/panoramas";
import {
  addTourScene,
  changeTourScene,
  createTour,
  loadTourEditor,
  loadTours,
  publishTour,
  updateTourScene,
  type TourRepository,
} from "./tours";

const owner = {
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "t",
  displayName: "T",
  role: "owner" as const,
  tenantStatus: "active" as const,
};
const editor = { ...owner, role: "editor" as const };
const analyst = { ...owner, role: "analyst" as const };

const TOUR = "70000000-0000-4000-8000-000000000001";
const SCENE = "70000000-0000-4000-8000-0000000000a1";
const PANO = "70000000-0000-4000-8000-0000000000b1";
const ASSET = "70000000-0000-4000-8000-0000000000c1";

const manifest = {
  version: 1,
  projection: "equirectangular",
  source: {
    width: 8192,
    height: 4096,
    bytes: 9_000_000,
    mime: "image/jpeg",
    sha256: "a".repeat(64),
  },
  preview: { file: "preview.webp", width: 1024, height: 512, bytes: 18_000 },
  image: { file: "image.webp", width: 4096, height: 2048, bytes: 1_400_000 },
  tiles: null,
} as const;

function revision(overrides: Partial<TourRevision> = {}): TourRevision {
  return {
    revisionId: "70000000-0000-4000-8000-0000000000d1",
    revisionNo: 1,
    state: "draft",
    editCount: 3,
    entrySceneId: SCENE,
    updatedAt: "2026-10-26T12:00:00Z",
    sealedAt: null,
    scenes: [
      {
        sceneId: SCENE,
        position: 0,
        title: "Entrada",
        description: "",
        initialView: { yaw: 0, pitch: 0, fov: 60 },
        panorama: {
          versionId: PANO,
          assetId: ASSET,
          version: 1,
          width: 8192,
          height: 4096,
          manifest,
        },
        hotspots: [],
      },
    ],
    ...overrides,
  };
}

function record(draft: TourRevision | null, published: TourRevision | null = null): TourRecord {
  return {
    tourId: TOUR,
    content: {
      contentId: ASSET,
      kind: "destination",
      slug: "museo",
      title: "Museo",
      published: true,
    },
    draft,
    published,
    history: [],
  };
}

function repository(overrides: Partial<TourRepository> = {}): TourRepository {
  const saved = { status: "saved" as const, editCount: 4 };
  return {
    list: vi.fn(async () => []),
    find: vi.fn(async () => record(revision())),
    revision: vi.fn(async () => null),
    create: vi.fn(async () => ({ status: "created" as const, tourId: TOUR })),
    addScene: vi.fn(async () => saved),
    updateScene: vi.fn(async () => saved),
    moveScene: vi.fn(async () => saved),
    removeScene: vi.fn(async () => saved),
    setEntryScene: vi.fn(async () => saved),
    publish: vi.fn(async () => ({ status: "published" as const, revisionNo: 1 })),
    restore: vi.fn(async () => ({ status: "restored" as const, revisionNo: 1 })),
    discardDraft: vi.fn(async () => ({ status: "discarded" as const })),
    addHotspot: vi.fn(async () => saved),
    updateHotspot: vi.fn(async () => saved),
    removeHotspot: vi.fn(async () => saved),
    hotspotTargets: vi.fn(async () => []),
    ...overrides,
  };
}

describe("scene views", () => {
  it("normalizes yaw into [-π, π)", () => {
    expect(normalizeYaw(Math.PI)).toBeCloseTo(-Math.PI);
    expect(normalizeYaw(3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(normalizeYaw(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    expect(normalizeYaw(7)).toBeCloseTo(7 - 2 * Math.PI);
  });

  it("rounds and bounds what a viewer reports", () => {
    expect(normalizeSceneView({ yaw: 6.2, pitch: 2, fov: 120 })).toEqual({
      yaw: -0.083,
      pitch: 1.57,
      fov: 90,
    });
    expect(normalizeSceneView({ yaw: Number.NaN, pitch: 0, fov: 60 })).toBeNull();
    // Rounding never pushes an angle past the limits the database checks.
    for (const yaw of [-Math.PI, -3.14159, 3.14159, Math.PI - 1e-9]) {
      const view = normalizeSceneView({ yaw, pitch: -Math.PI / 2, fov: 29.96 });
      expect(view && view.yaw >= -Math.PI && view.yaw < Math.PI).toBe(true);
      expect(view && view.pitch >= -Math.PI / 2 && view.fov >= 30).toBe(true);
    }
  });
});

describe("scene fields", () => {
  it("trims titles and refuses empty, long or control characters", () => {
    expect(parseSceneTitle("  Sala   principal ")).toEqual({ title: "Sala principal" });
    expect(parseSceneTitle("   ")).toEqual({ issue: { field: "title", code: "required" } });
    expect(parseSceneTitle("x".repeat(121))).toEqual({
      issue: { field: "title", code: "too_long" },
    });
    expect(parseSceneTitle(4)).toEqual({ issue: { field: "title", code: "invalid" } });
  });

  it("only validates and returns the fields that were sent", () => {
    expect(parseSceneChanges({ title: "Patio" })).toEqual({
      ok: true,
      changes: { title: "Patio" },
    });
    expect(parseSceneChanges({ description: "" })).toEqual({
      ok: true,
      changes: { description: "" },
    });
    expect(parseSceneChanges({ initialView: { yaw: "1", pitch: 0, fov: 60 } })).toEqual({
      ok: true,
      changes: { initialView: { yaw: 1, pitch: 0, fov: 60 } },
    });
    expect(parseSceneChanges({ initialView: { yaw: "x", pitch: 0, fov: 60 } })).toMatchObject({
      ok: false,
    });
    expect(parseSceneChanges({})).toMatchObject({ ok: false });
  });

  it("lists what keeps a revision from being published", () => {
    expect(tourPublicationIssues(revision({ scenes: [], entrySceneId: null }))).toEqual([
      "no_scenes",
    ]);
    expect(tourPublicationIssues(revision({ entrySceneId: null }))).toEqual(["no_entry"]);
    expect(tourPublicationIssues(revision())).toEqual([]);
  });
});

describe("tour use cases", () => {
  it("offers only content without a tour", async () => {
    const tours = repository({
      list: vi.fn(async () => [
        {
          tourId: TOUR,
          contentId: "c1",
          contentKind: "destination" as const,
          contentSlug: "a",
          contentTitle: "A",
          contentPublished: true,
          status: "draft" as const,
          scenes: 0,
          updatedAt: "",
          publishedAt: null,
        },
      ]),
    });
    const result = await loadTours(editor, {
      tours,
      candidates: async () => [
        { contentId: "c1", kind: "destination", title: "A" },
        { contentId: "c2", kind: "event", title: "B" },
      ],
    });
    expect(result.candidates.map((candidate) => candidate.contentId)).toEqual(["c2"]);
    expect(result.canEdit).toBe(true);
  });

  it("keeps analysts out of every edit and editors out of publishing", async () => {
    const tours = repository();
    expect(await createTour(analyst, ASSET, tours)).toEqual({ status: "forbidden" });
    expect(
      await addTourScene(
        analyst,
        { tourId: TOUR, expectedEdit: 1, panoramaVersionId: PANO, title: "A" },
        tours,
      ),
    ).toEqual({ status: "forbidden" });
    expect(await publishTour(editor, { tourId: TOUR, expectedEdit: 1 }, tours)).toEqual({
      status: "forbidden",
    });
    expect(tours.addScene).not.toHaveBeenCalled();
    expect(tours.publish).not.toHaveBeenCalled();
  });

  it("rejects malformed ids and edit numbers before reaching the database", async () => {
    const tours = repository();
    expect(await createTour(editor, "nope", tours)).toEqual({ status: "not_found" });
    expect(
      await addTourScene(
        editor,
        { tourId: TOUR, expectedEdit: 0, panoramaVersionId: PANO, title: "A" },
        tours,
      ),
    ).toEqual({ status: "not_found" });
    expect(
      await changeTourScene(
        editor,
        { tourId: TOUR, expectedEdit: 2, sceneId: SCENE },
        { kind: "move", position: -1 },
        tours,
      ),
    ).toEqual({ status: "invalid", reason: "shape" });
    expect(tours.moveScene).not.toHaveBeenCalled();
  });

  it("sends a cleaned title and only the changed fields", async () => {
    const tours = repository();
    await addTourScene(
      editor,
      { tourId: TOUR, expectedEdit: null, panoramaVersionId: PANO, title: " Sala " },
      tours,
    );
    expect(tours.addScene).toHaveBeenCalledWith(owner.tenantId, TOUR, null, PANO, "Sala");
    await updateTourScene(
      editor,
      { tourId: TOUR, expectedEdit: 3, sceneId: SCENE, changes: { title: "Patio" } },
      tours,
    );
    expect(tours.updateScene).toHaveBeenCalledWith(owner.tenantId, TOUR, 3, SCENE, {
      title: "Patio",
    });
    expect(
      await updateTourScene(
        editor,
        { tourId: TOUR, expectedEdit: 3, sceneId: SCENE, changes: { title: "" } },
        tours,
      ),
    ).toEqual({ status: "rejected", issues: [{ field: "title", code: "required" }] });
  });

  it("builds the editor from the draft with signed previews and the free panoramas", async () => {
    const tours = repository();
    const ready: PanoramaView = {
      versionId: "70000000-0000-4000-8000-0000000000b2",
      assetId: "70000000-0000-4000-8000-0000000000c2",
      version: 1,
      status: "ready",
      declaredBytes: 1,
      width: 8192,
      height: 4096,
      problem: null,
      manifest,
      createdAt: "",
      readyAt: "",
      job: null,
    };
    const used: PanoramaView = { ...ready, versionId: PANO, assetId: ASSET };
    const processing: PanoramaView = {
      ...ready,
      versionId: "70000000-0000-4000-8000-0000000000b3",
      status: "processing",
      manifest: null,
    };
    const signedPreviewUrls = vi.fn(
      async (paths: readonly string[]) => new Map(paths.map((path) => [path, `signed:${path}`])),
    );
    const editorView = await loadTourEditor(editor, TOUR, {
      tours,
      panoramas: { list: async () => [ready, used, processing] },
      models: { list: async () => [] },
      media: { signedPreviewUrls },
    });
    expect(editorView?.editCount).toBe(3);
    expect(editorView?.scenes[0]?.imageUrl).toBe(
      `signed:${owner.tenantId}/${ASSET}/1/panorama/image.webp`,
    );
    expect(editorView?.options.map((option) => option.versionId)).toEqual([ready.versionId]);
    expect(editorView?.canPublish).toBe(false);

    const readOnly = await loadTourEditor(analyst, TOUR, {
      tours,
      panoramas: { list: vi.fn(async () => [ready]) },
      models: { list: vi.fn(async () => []) },
      media: { signedPreviewUrls },
    });
    expect(readOnly?.options).toEqual([]);
  });

  it("shows the published revision when there is no draft", async () => {
    const published = revision({ state: "sealed", sealedAt: "2026-10-26T12:00:00Z", editCount: 5 });
    const tours = repository({ find: vi.fn(async () => record(null, published)) });
    const view = await loadTourEditor(owner, TOUR, {
      tours,
      panoramas: { list: async () => [] },
      models: { list: async () => [] },
      media: { signedPreviewUrls: async () => new Map() },
    });
    expect(view?.revision.state).toBe("sealed");
    expect(view?.editCount).toBeNull();
  });

  it("parses the editor document the database returns", () => {
    const [scene] = revision().scenes;
    if (!scene) throw new Error("fixture without scenes");
    const parsed = tourRecordSchema.parse({
      ...record(revision()),
      draft: {
        ...revision(),
        scenes: [{ ...scene, panorama: { ...scene.panorama, manifest: { broken: true } } }],
      },
    });
    expect(parsed.draft?.scenes[0]?.panorama.manifest).toBeNull();
  });
});
