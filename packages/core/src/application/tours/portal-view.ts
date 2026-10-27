import type { PublishedTour, TourManifestHotspot, TourManifestScene } from "../../contracts/tour";
import type {
  TourViewerModel,
  TourViewerPanorama,
  TourViewerPoint,
} from "../../domain/tours/viewer";
import { tourPath } from "../content/portal";

interface PointBase {
  readonly id: string;
  readonly title: string;
  readonly yaw: number;
  readonly pitch: number;
}

const isPowerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0;

/**
 * The viewer (Photo Sphere Viewer's tiles adapter) needs a power of two of columns and rows.
 * The pipeline's top level follows the source (5760 px → 5120 px, 10 columns), so such a
 * level is left out and the next one down (4096 px) serves as the sharpest.
 */
function viewerLevels(levels: NonNullable<TourManifestScene["panorama"]["tiles"]>["levels"]) {
  return [...levels]
    .filter((level) => isPowerOfTwo(level.cols) && isPowerOfTwo(level.rows))
    .sort((a, b) => a.width - b.width)
    .map((level) => ({ width: level.width, cols: level.cols, rows: level.rows, dir: level.dir }));
}

function panoramaOf(scene: TourManifestScene): TourViewerPanorama {
  const { folder, preview, image, tiles } = scene.panorama;
  const levels = tiles ? viewerLevels(tiles.levels) : [];
  return {
    preview: folder + preview.file,
    image: { path: folder + image.file, width: image.width, height: image.height },
    tiles: levels.length > 0 ? { folder, levels } : null,
  };
}

function pointOf(
  hotspot: TourManifestHotspot,
  sceneTitles: ReadonlyMap<string, string>,
  tour: PublishedTour,
): TourViewerPoint | null {
  const base: PointBase = {
    id: hotspot.hotspotId,
    title: hotspot.title,
    yaw: hotspot.position.yaw,
    pitch: hotspot.position.pitch,
  };
  switch (hotspot.kind) {
    case "info":
      return { ...base, kind: "info", body: hotspot.body, gallery: hotspot.gallery };
    case "scene": {
      const targetTitle = hotspot.targetSceneId ? sceneTitles.get(hotspot.targetSceneId) : null;
      if (!hotspot.targetSceneId || targetTitle === undefined || targetTitle === null) return null;
      return { ...base, kind: "scene", targetSceneId: hotspot.targetSceneId, targetTitle };
    }
    case "model": {
      const model = hotspot.model;
      if (!model) return null;
      return {
        ...base,
        kind: "model",
        body: hotspot.body,
        poster: {
          path: model.folder + model.poster.file,
          width: model.poster.width,
          height: model.poster.height,
        },
        model: {
          path: model.folder + model.file,
          bytes: model.bytes,
          heavy: model.weight === "heavy",
        },
      };
    }
    case "tour": {
      const target = hotspot.targetContentId ? tour.targets[hotspot.targetContentId] : undefined;
      if (!target) return null;
      return {
        ...base,
        kind: "tour",
        target: { ...target, href: tourPath(target.kind, target.slug) },
      };
    }
  }
}

/** The scenes in their published order, the entry first only if the municipality put it there. */
export function tourViewerModel(tour: PublishedTour): TourViewerModel {
  const { manifest } = tour;
  const titles = new Map(manifest.scenes.map((scene) => [scene.sceneId, scene.title]));
  return {
    kind: tour.kind,
    slug: tour.slug,
    title: tour.title,
    revisionNo: tour.revisionNo,
    entrySceneId: manifest.entrySceneId,
    scenes: manifest.scenes.map((scene) => ({
      id: scene.sceneId,
      title: scene.title,
      description: scene.description,
      initialView: scene.initialView,
      panorama: panoramaOf(scene),
      points: scene.hotspots.flatMap((hotspot) => {
        const point = pointOf(hotspot, titles, tour);
        return point ? [point] : [];
      }),
    })),
  };
}
