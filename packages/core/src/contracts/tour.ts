import { z } from "zod";

import { panoramaManifestSchema } from "./panorama";

/**
 * Tours 360° (ADR-028): at most one per destination or event, numbered revisions of a
 * graph of scenes with ONE entry scene. Angles are radians, independent of how the
 * panorama is delivered (ADR-020): yaw in [-π, π), pitch in [-π/2, π/2]; the field of
 * view is in degrees.
 */
export const TOUR_LIMITS = {
  scenes: 60,
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
  }),
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
