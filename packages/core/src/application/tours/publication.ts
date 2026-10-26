import type {
  PublishedTour,
  PublishedTourIndexEntry,
  TourContentKind,
  TourRevision,
} from "../../contracts/tour";
import { publishContentImages } from "../media/content-images";
import type { MediaAdmin } from "../media/ports";

/**
 * What a tour revision needs in the public bucket before it is sealed (ADR-030): each
 * panorama's preview, image and tiles, each model with its poster, and the points' photos.
 * What is already public (another tour uses it, or an earlier publication) is skipped;
 * photos are always re-copied (three small files each, idempotent).
 */
export interface TourMediaPlan {
  readonly files: readonly {
    readonly assetId: string;
    readonly version: number;
    readonly files: readonly string[];
  }[];
  readonly photos: readonly { readonly assetId: string; readonly version: number }[];
}

export function tourMediaPlan(revision: TourRevision): TourMediaPlan {
  const files = new Map<string, { assetId: string; version: number; files: string[] }>();
  for (const scene of revision.scenes) {
    const { panorama } = scene;
    if (!panorama.published && panorama.manifest) {
      const list = [
        `panorama/${panorama.manifest.preview.file}`,
        `panorama/${panorama.manifest.image.file}`,
      ];
      for (const level of panorama.manifest.tiles?.levels ?? []) {
        for (let col = 0; col < level.cols; col += 1) {
          for (let row = 0; row < level.rows; row += 1)
            list.push(`panorama/${level.dir}/${col}_${row}.webp`);
        }
      }
      files.set(panorama.versionId, {
        assetId: panorama.assetId,
        version: panorama.version,
        files: list,
      });
    }
    for (const hotspot of scene.hotspots) {
      const model = hotspot.model;
      if (model && !model.published && model.manifest?.poster && !files.has(model.versionId)) {
        files.set(model.versionId, {
          assetId: model.assetId,
          version: model.version,
          files: [`model/${model.manifest.model.file}`, `model/${model.manifest.poster.file}`],
        });
      }
    }
  }
  const photos = revision.scenes.flatMap((scene) =>
    scene.hotspots.flatMap((hotspot) =>
      hotspot.gallery.map(({ assetId, version }) => ({ assetId, version })),
    ),
  );
  return { files: [...files.values()], photos };
}

/** Copies everything the plan lists (panoramas and models first, then photos). */
export async function publishTourMedia(
  tenantId: string,
  plan: TourMediaPlan,
  admin: Pick<MediaAdmin, "publish" | "publishFiles">,
): Promise<number> {
  let copied = 0;
  for (const entry of plan.files) {
    await admin.publishFiles(tenantId, entry.assetId, entry.version, entry.files);
    copied += entry.files.length;
  }
  await publishContentImages(tenantId, plan.photos, admin);
  return copied;
}

/** Anonymous reads for portals: only published tours of published content (ADR-030). */
export interface PublishedTourReader {
  /** The general tour's index (no ended events). */
  index(tenantId: string): Promise<PublishedTourIndexEntry[]>;
  find(tenantId: string, kind: TourContentKind, slug: string): Promise<PublishedTour | null>;
}
