import { z } from "zod";

import { imageReferenceSchema, type ImageReference } from "./destination";
import { modelManifestSchema } from "./model";
import { panoramaManifestSchema } from "./panorama";
import { richTextSchema, type RichText } from "./rich-text";

/**
 * Tours 360° (ADR-028): at most one per destination or event, numbered revisions of a
 * graph of scenes with ONE entry scene. Angles are radians, independent of how the
 * panorama is delivered (ADR-020): yaw in [-π, π), pitch in [-π/2, π/2]; the field of
 * view is in degrees.
 */
export const TOUR_LIMITS = {
  scenes: 60,
  hotspotsPerScene: 50,
  hotspotTitle: 120,
  hotspotPhotos: 12,
  hotspotBodyBytes: 20_000,
  sceneTitle: 120,
  sceneDescription: 1000,
  fov: { min: 30, max: 90, initial: 60 },
} as const;

export const sceneViewSchema = z
  .object({
    yaw: z
      .number()
      .min(-Math.PI)
      .refine((value) => value < Math.PI, "yaw < π"),
    pitch: z
      .number()
      .min(-Math.PI / 2)
      .max(Math.PI / 2),
    fov: z.number().min(TOUR_LIMITS.fov.min).max(TOUR_LIMITS.fov.max),
  })
  .strict();

export type SceneView = z.infer<typeof sceneViewSchema>;

export const hotspotPositionSchema = z
  .object({
    yaw: z
      .number()
      .min(-Math.PI)
      .refine((value) => value < Math.PI, "yaw < π"),
    pitch: z
      .number()
      .min(-Math.PI / 2)
      .max(Math.PI / 2),
  })
  .strict();

export type HotspotPosition = z.infer<typeof hotspotPositionSchema>;

/**
 * The four kinds of points (ADR-029): information (text and photos), navigation to another
 * scene of the same tour, a 3D model, and "go to another tour" (a destination or event of
 * the same municipality, resolved to its published entry when visitors open it).
 */
export const HOTSPOT_KINDS = ["info", "scene", "model", "tour"] as const;
export type HotspotKind = (typeof HOTSPOT_KINDS)[number];

export const tourHotspotSchema = z.object({
  hotspotId: z.uuid(),
  kind: z.enum(HOTSPOT_KINDS),
  position: hotspotPositionSchema,
  title: z.string(),
  body: richTextSchema.catch([]),
  gallery: z.array(imageReferenceSchema),
  targetSceneId: z.uuid().nullable(),
  model: z
    .object({
      versionId: z.uuid(),
      assetId: z.uuid(),
      version: z.number().int().min(1),
      manifest: modelManifestSchema.nullable().catch(null),
      /** Already copied to the public bucket (P4 · Paso 3). */
      published: z.boolean().default(false),
    })
    .nullable(),
  target: z
    .object({
      contentId: z.uuid(),
      kind: z.enum(["destination", "event"]),
      slug: z.string(),
      title: z.string(),
      published: z.boolean(),
      tourPublished: z.boolean(),
    })
    .nullable(),
});

export type TourHotspot = z.infer<typeof tourHotspotSchema>;

export const tourSceneSchema = z.object({
  sceneId: z.uuid(),
  position: z.number().int().min(0),
  title: z.string(),
  description: z.string(),
  initialView: sceneViewSchema,
  panorama: z.object({
    versionId: z.uuid(),
    assetId: z.uuid(),
    version: z.number().int().min(1),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    /** null if the manifest cannot be read (never for a ready panorama). */
    manifest: panoramaManifestSchema.nullable().catch(null),
    /** Already copied to the public bucket (P4 · Paso 3). */
    published: z.boolean().default(false),
  }),
  hotspots: z.array(tourHotspotSchema).default([]),
});

export type TourScene = z.infer<typeof tourSceneSchema>;

export const tourRevisionSchema = z.object({
  revisionId: z.uuid(),
  revisionNo: z.number().int().min(1),
  state: z.enum(["draft", "sealed"]),
  editCount: z.number().int().min(1),
  entrySceneId: z.uuid().nullable(),
  updatedAt: z.string(),
  sealedAt: z.string().nullable(),
  /** In order. */
  scenes: z.array(tourSceneSchema),
});

export type TourRevision = z.infer<typeof tourRevisionSchema>;

export const tourContentKindSchema = z.enum(["destination", "event"]);
export type TourContentKind = z.infer<typeof tourContentKindSchema>;

export const tourRecordSchema = z.object({
  tourId: z.uuid(),
  /** What the tour belongs to. */
  content: z.object({
    contentId: z.uuid(),
    kind: tourContentKindSchema,
    slug: z.string(),
    title: z.string(),
    published: z.boolean(),
  }),
  draft: tourRevisionSchema.nullable(),
  published: tourRevisionSchema.nullable(),
  /** Sealed revisions, newest first. */
  history: z.array(
    z.object({
      revisionId: z.uuid(),
      revisionNo: z.number().int(),
      sealedAt: z.string(),
      scenes: z.number().int(),
    }),
  ),
});

export type TourRecord = z.infer<typeof tourRecordSchema>;

/** What may change in a scene; what is not sent stays as it was (RC-01). */
export interface SceneChanges {
  readonly title?: string;
  readonly description?: string;
  readonly initialView?: SceneView;
}

/** A new point, as the panel sends it (the kind's target is required). */
export type NewHotspot =
  | {
      readonly kind: "info";
      readonly title: string;
      readonly position: HotspotPosition;
      readonly body?: RichText;
      readonly gallery?: readonly ImageReference[];
    }
  | {
      readonly kind: "scene";
      readonly title: string;
      readonly position: HotspotPosition;
      readonly targetSceneId: string;
    }
  | {
      readonly kind: "model";
      readonly title: string;
      readonly position: HotspotPosition;
      readonly modelVersionId: string;
    }
  | {
      readonly kind: "tour";
      readonly title: string;
      readonly position: HotspotPosition;
      readonly targetContentId: string;
    };

/** What may change in a point; what is not sent stays as it was, and the kind never changes. */
export interface HotspotChanges {
  readonly title?: string;
  readonly position?: HotspotPosition;
  readonly body?: RichText;
  readonly gallery?: readonly ImageReference[];
  readonly targetSceneId?: string;
  readonly modelVersionId?: string;
  readonly targetContentId?: string;
}

/** A destination or event a "go to another tour" point can lead to. */
export interface HotspotTargetOption {
  readonly contentId: string;
  readonly kind: "destination" | "event";
  readonly title: string;
  readonly published: boolean;
  readonly tourPublished: boolean;
}

// ── What visitors read (P4 · Paso 3, ADR-030) ───────────────────────────────

const publicFile = z.object({
  file: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
});

/** The public snapshot a sealed revision keeps: only what visitors need, never the editor's. */
export const tourManifestSchema = z.object({
  version: z.literal(1),
  revisionNo: z.number().int().min(1),
  entrySceneId: z.uuid(),
  scenes: z.array(
    z.object({
      sceneId: z.uuid(),
      title: z.string(),
      description: z.string(),
      initialView: sceneViewSchema,
      panorama: z.object({
        /** {tenant}/{asset}/{version}/panorama/ in the public bucket. */
        folder: z.string(),
        width: z.number().int(),
        height: z.number().int(),
        preview: publicFile,
        image: publicFile,
        tiles: panoramaManifestSchema.shape.tiles,
      }),
      hotspots: z.array(
        z.object({
          hotspotId: z.uuid(),
          kind: z.enum(HOTSPOT_KINDS),
          position: hotspotPositionSchema,
          title: z.string(),
          body: richTextSchema.catch([]),
          gallery: z.array(
            z.object({
              assetId: z.uuid(),
              version: z.number().int(),
              alt: z.string(),
              width: z.number().int(),
              height: z.number().int(),
            }),
          ),
          targetSceneId: z.uuid().nullable(),
          model: z
            .object({
              folder: z.string(),
              file: z.string(),
              bytes: z.number().int(),
              weight: z.enum(["light", "heavy"]),
              poster: publicFile,
            })
            .nullable(),
          targetContentId: z.uuid().nullable(),
        }),
      ),
    }),
  ),
});

export type TourManifest = z.infer<typeof tourManifestSchema>;
export type TourManifestScene = TourManifest["scenes"][number];
export type TourManifestHotspot = TourManifestScene["hotspots"][number];

/** Where a "go to another tour" point leads, resolved when the tour is read. */
export interface PublishedTourTarget {
  readonly kind: TourContentKind;
  readonly slug: string;
  readonly title: string;
}

export interface PublishedTour {
  readonly kind: TourContentKind;
  readonly slug: string;
  readonly title: string;
  readonly revisionNo: number;
  readonly publishedAt: string;
  /** Events: already over (the tour page stays, like the event's). */
  readonly ended: boolean;
  readonly manifest: TourManifest;
  /** By content id; a "go to" point whose target is missing here is hidden. */
  readonly targets: Readonly<Record<string, PublishedTourTarget>>;
}

/** One row of the general tour's index (only the entry's preview, never the whole tour). */
export interface PublishedTourIndexEntry {
  readonly kind: TourContentKind;
  readonly slug: string;
  readonly title: string;
  readonly scenes: number;
  readonly entryTitle: string;
  /** {tenant}/{asset}/{version}/panorama/ and the preview file inside it. */
  readonly entryFolder: string;
  readonly entryPreview: { readonly file: string; readonly width: number; readonly height: number };
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly publishedAt: string;
}
