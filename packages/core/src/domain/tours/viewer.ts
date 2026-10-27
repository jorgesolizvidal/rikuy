/**
 * The public tour viewer's model and its navigation rules, without schemas: browser code
 * imports them from "@rikuy/core/tour-viewer" (no zod in the page bundle).
 */
import type { RichText } from "../../contracts/rich-text";
import type { SceneView, TourContentKind } from "../../contracts/tour";

/**
 * What the portal's tour viewer needs from a sealed manifest (P4 · Paso 4): scenes in their
 * order, storage paths (the web layer turns them into public URLs) and only the points a
 * visitor can use. A "go to another tour" whose target has no visible tour, or a "go to a
 * scene" that is not in this revision, is left out rather than shown broken.
 */
export interface TourViewerPanorama {
  /** Blurred preview shown at once (≤ 40 KB). */
  readonly preview: string;
  /** The single image (≤ 4096 px): the only image for small sources, the flat fallback. */
  readonly image: { readonly path: string; readonly width: number; readonly height: number };
  /** Equirectangular tiles by level, smallest first; null when the image is enough. */
  readonly tiles: {
    /** Path prefix of the level folders: `{folder}{dir}/{col}_{row}.webp`. */
    readonly folder: string;
    readonly levels: readonly {
      readonly width: number;
      readonly cols: number;
      readonly rows: number;
      readonly dir: string;
    }[];
  } | null;
}

interface PointBase {
  readonly id: string;
  readonly title: string;
  readonly yaw: number;
  readonly pitch: number;
}

export type TourViewerPoint =
  | (PointBase & {
      readonly kind: "info";
      readonly body: RichText;
      readonly gallery: readonly {
        readonly assetId: string;
        readonly version: number;
        readonly alt: string;
        readonly width: number;
        readonly height: number;
      }[];
    })
  | (PointBase & {
      readonly kind: "scene";
      readonly targetSceneId: string;
      readonly targetTitle: string;
    })
  | (PointBase & {
      readonly kind: "model";
      readonly poster: { readonly path: string; readonly width: number; readonly height: number };
      readonly model: { readonly path: string; readonly bytes: number; readonly heavy: boolean };
    })
  | (PointBase & {
      readonly kind: "tour";
      readonly target: {
        readonly kind: TourContentKind;
        readonly slug: string;
        readonly title: string;
        readonly href: string;
      };
    });

export interface TourViewerScene {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly initialView: SceneView;
  readonly panorama: TourViewerPanorama;
  readonly points: readonly TourViewerPoint[];
}

export interface TourViewerModel {
  readonly kind: TourContentKind;
  readonly slug: string;
  readonly title: string;
  readonly revisionNo: number;
  readonly entrySceneId: string;
  readonly scenes: readonly TourViewerScene[];
}

/** The query parameter that opens a tour on one scene (shared links). */
export const TOUR_SCENE_QUERY = "escena";

/** Just what navigation needs (the server's model and the browser's copy both fit). */
interface SceneOrder<S extends { readonly id: string }> {
  readonly entrySceneId: string;
  readonly scenes: readonly S[];
}

/** The scene a link asks for (`?escena=`), or the entry when it is missing or unknown. */
export function startingScene<S extends { readonly id: string }>(
  model: SceneOrder<S>,
  requested: unknown,
): S {
  const scenes = model.scenes;
  const wanted =
    typeof requested === "string" ? scenes.find((scene) => scene.id === requested) : undefined;
  const entry = scenes.find((scene) => scene.id === model.entrySceneId) ?? scenes[0];
  const scene = wanted ?? entry;
  if (!scene) throw new Error("A published tour has at least one scene");
  return scene;
}

/** The scene before and after one, in the published order (none at the ends). */
export function neighbourScenes<S extends { readonly id: string }>(
  model: SceneOrder<S>,
  sceneId: string,
): { readonly previous: S | null; readonly next: S | null } {
  const index = model.scenes.findIndex((scene) => scene.id === sceneId);
  if (index === -1) return { previous: null, next: null };
  return { previous: model.scenes[index - 1] ?? null, next: model.scenes[index + 1] ?? null };
}
