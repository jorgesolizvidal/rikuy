import { describe, expect, it, vi } from "vitest";

import { parseHotspotBody, parseHotspotChanges, parseNewHotspot } from "../../domain/tours/hotspot";
import { normalizeHotspotPosition, tourPublicationIssues } from "../../domain/tours/scene";
import type { TourRevision } from "../../contracts/tour";
import { addTourHotspot, removeTourHotspot, updateTourHotspot, type TourRepository } from "./tours";

const editor = {
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "t",
  displayName: "T",
  role: "editor" as const,
  tenantStatus: "active" as const,
};
const analyst = { ...editor, role: "analyst" as const };
const TOUR = "70000000-0000-4000-8000-000000000001";
const SCENE = "70000000-0000-4000-8000-0000000000a1";
const OTHER = "70000000-0000-4000-8000-0000000000a2";
const SPOT = "70000000-0000-4000-8000-0000000000e1";
const IMG = "70000000-0000-4000-8000-0000000000f1";
const at = { yaw: 0.5, pitch: -0.2 };

function tours(): Pick<TourRepository, "addHotspot" | "updateHotspot" | "removeHotspot"> {
  const saved = { status: "saved" as const, editCount: 5 };
  return {
    addHotspot: vi.fn(async () => saved),
    updateHotspot: vi.fn(async () => saved),
    removeHotspot: vi.fn(async () => saved),
  };
}

describe("hotspot rules", () => {
  it("keeps positions inside what the database accepts", () => {
    expect(normalizeHotspotPosition({ yaw: Math.PI, pitch: Math.PI / 2 })).toEqual({
      yaw: -3.141,
      pitch: 1.57,
    });
    expect(normalizeHotspotPosition({ yaw: 7, pitch: 0 })?.yaw).toBeCloseTo(7 - 2 * Math.PI, 2);
    expect(normalizeHotspotPosition({ yaw: Number.NaN, pitch: 0 })).toBeNull();
  });

  it("turns the typed text into the allowed rich text and flags http links by line", () => {
    expect(parseHotspotBody("Usado hasta **1953**.")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Usado hasta " },
          { type: "text", text: "1953", marks: ["bold"] },
          { type: "text", text: "." },
        ],
      },
    ]);
    expect(parseHotspotBody("Hola\n\n[sitio](http://x.example)")).toEqual([
      { field: "body", code: "link_not_https", line: 3 },
    ]);
    expect(parseHotspotBody("x".repeat(4001))).toEqual([{ field: "body", code: "too_long" }]);
  });

  it("requires each kind's own target", () => {
    expect(parseNewHotspot({ kind: "scene", title: "A la sala", position: at })).toEqual({
      ok: false,
      issues: [{ field: "target", code: "required" }],
    });
    expect(
      parseNewHotspot({ kind: "scene", title: " A la sala ", position: at, targetSceneId: OTHER }),
    ).toEqual({
      ok: true,
      hotspot: { kind: "scene", title: "A la sala", position: at, targetSceneId: OTHER },
    });
    expect(parseNewHotspot({ kind: "puerta", title: "X", position: at })).toMatchObject({
      ok: false,
    });
    expect(parseNewHotspot({ kind: "info", title: "", position: { yaw: "x" } })).toEqual({
      ok: false,
      issues: [
        { field: "title", code: "required" },
        { field: "position", code: "invalid" },
      ],
    });
  });

  it("asks for a description of every photo", () => {
    expect(
      parseNewHotspot({
        kind: "info",
        title: "Arado",
        position: at,
        gallery: [{ assetId: IMG, version: 1, alt: " " }],
      }),
    ).toEqual({ ok: false, issues: [{ field: "gallery", code: "alt_required", index: 0 }] });
  });

  it("only validates and returns what the form sent, for the point's own kind", () => {
    expect(parseHotspotChanges("info", { title: "Arado tallado" })).toEqual({
      ok: true,
      changes: { title: "Arado tallado" },
    });
    expect(parseHotspotChanges("model", { position: { yaw: 0.25, pitch: -0.5 } })).toEqual({
      ok: true,
      changes: { position: { yaw: 0.25, pitch: -0.5 } },
    });
    expect(parseHotspotChanges("scene", { body: "Texto" })).toMatchObject({ ok: false });
    expect(parseHotspotChanges("scene", { modelVersionId: IMG })).toMatchObject({ ok: false });
    expect(parseHotspotChanges("tour", { kind: "info" })).toMatchObject({ ok: false });
    expect(parseHotspotChanges("info", { gallery: [] })).toEqual({
      ok: true,
      changes: { gallery: [] },
    });
  });

  it("asks for a poster on model points before publishing", () => {
    const revision = (poster: boolean): TourRevision => ({
      revisionId: TOUR,
      revisionNo: 1,
      state: "draft",
      editCount: 2,
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
            versionId: IMG,
            assetId: IMG,
            version: 1,
            width: 8192,
            height: 4096,
            published: true,
            manifest: {
              version: 1,
              projection: "equirectangular",
              source: {
                width: 8192,
                height: 4096,
                bytes: 1,
                mime: "image/jpeg",
                sha256: "a".repeat(64),
              },
              preview: { file: "preview.webp", width: 1024, height: 512, bytes: 1 },
              image: { file: "image.webp", width: 4096, height: 2048, bytes: 1 },
              tiles: null,
            },
          },
          hotspots: [
            {
              hotspotId: SPOT,
              kind: "model",
              position: at,
              title: "Horno",
              body: [],
              gallery: [],
              targetSceneId: null,
              target: null,
              model: {
                versionId: IMG,
                assetId: IMG,
                version: 1,
                published: true,
                manifest: poster
                  ? ({
                      poster: { file: "poster.webp", width: 1280, height: 960, bytes: 1 },
                    } as never)
                  : null,
              },
            },
          ],
        },
      ],
    });
    expect(tourPublicationIssues(revision(false))).toEqual(["model_poster"]);
    expect(tourPublicationIssues(revision(true))).toEqual([]);
  });
});

describe("hotspot use cases", () => {
  it("keeps analysts out and refuses malformed input before the database", async () => {
    const repo = tours();
    expect(
      await addTourHotspot(
        analyst,
        {
          tourId: TOUR,
          expectedEdit: 1,
          sceneId: SCENE,
          hotspot: { kind: "info", title: "X", position: at },
        },
        repo,
      ),
    ).toEqual({ status: "forbidden" });
    expect(
      await removeTourHotspot(editor, { tourId: TOUR, expectedEdit: 1, hotspotId: "nope" }, repo),
    ).toEqual({
      status: "not_found",
    });
    expect(repo.addHotspot).not.toHaveBeenCalled();
    expect(repo.removeHotspot).not.toHaveBeenCalled();
  });

  it("sends the cleaned point and only the changed fields", async () => {
    const repo = tours();
    await addTourHotspot(
      editor,
      {
        tourId: TOUR,
        expectedEdit: null,
        sceneId: SCENE,
        hotspot: { kind: "info", title: "Arado", position: at, body: "Usado hasta 1953." },
      },
      repo,
    );
    expect(repo.addHotspot).toHaveBeenCalledWith(editor.tenantId, TOUR, null, SCENE, {
      kind: "info",
      title: "Arado",
      position: at,
      body: [{ type: "paragraph", children: [{ type: "text", text: "Usado hasta 1953." }] }],
      gallery: [],
    });
    await updateTourHotspot(
      editor,
      {
        tourId: TOUR,
        expectedEdit: 4,
        hotspotId: SPOT,
        kind: "info",
        changes: { title: "Arado tallado" },
      },
      repo,
    );
    expect(repo.updateHotspot).toHaveBeenCalledWith(editor.tenantId, TOUR, 4, SPOT, {
      title: "Arado tallado",
    });
  });
});
