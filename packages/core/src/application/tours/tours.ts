import type { OrganizationMembership } from "../../contracts/organization";
import type { ImageReference } from "../../contracts/destination";
import type {
  HotspotChanges,
  HotspotKind,
  HotspotTargetOption,
  NewHotspot,
  SceneChanges,
  TourContentKind,
  TourHotspot,
  TourRecord,
  TourRevision,
  TourScene,
} from "../../contracts/tour";
import {
  parseHotspotChanges,
  parseNewHotspot,
  type HotspotIssue,
} from "../../domain/tours/hotspot";
import {
  parseSceneChanges,
  parseSceneTitle,
  tourPublicationIssues,
  type SceneIssue,
  type TourPublicationIssue,
} from "../../domain/tours/scene";
import { canEditContent, canPublishContent } from "../content/editing";
import type { ContentStatus } from "../content/ports";
import { contentImagePath } from "../media/content-images";
import { MODEL_FOLDER, type ModelRepository } from "../media/models";
import { PANORAMA_FOLDER, type PanoramaRepository } from "../media/panoramas";
import { imageVersionPrefix, type MediaRepository } from "../media/ports";

/**
 * Tours 360° in the panel (P4 · Paso 1, ADR-028). The same people as destinations edit
 * them (owners, admins, editors) and publish them (owners, admins). Every edit is a small
 * intent with the draft's edit number, so two tabs never overwrite each other silently.
 */

export interface TourListEntry {
  readonly tourId: string;
  readonly contentId: string;
  readonly contentKind: TourContentKind;
  readonly contentSlug: string;
  readonly contentTitle: string;
  readonly contentPublished: boolean;
  readonly status: ContentStatus;
  readonly scenes: number;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

/** Result of an edit on the draft. */
export type TourEditOutcome =
  | { readonly status: "saved"; readonly editCount: number }
  | {
      readonly status: "invalid";
      readonly reason:
        | "title"
        | "panorama"
        | "limit"
        | "shape"
        | "target"
        | "model"
        | "body"
        | "gallery"
        | "position";
    }
  | { readonly status: "duplicate" | "conflict" | "forbidden" | "not_found" };

export type CreateTourOutcome =
  | { readonly status: "created"; readonly tourId: string }
  | { readonly status: "exists" | "forbidden" | "not_found" };

export type PublishTourOutcome =
  | { readonly status: "published"; readonly revisionNo: number }
  | {
      readonly status: "incomplete" | "media" | "poster" | "conflict" | "forbidden" | "not_found";
    };

export type RestoreTourOutcome =
  | { readonly status: "restored"; readonly revisionNo: number }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type DiscardTourOutcome =
  | { readonly status: "discarded" }
  | { readonly status: "never_published" | "conflict" | "forbidden" | "not_found" };

/** Tours with the signed-in user's session (RLS and RPC checks apply). */
export interface TourRepository {
  list(tenantId: string): Promise<TourListEntry[]>;
  find(tenantId: string, tourId: string): Promise<TourRecord | null>;
  revision(tenantId: string, revisionId: string): Promise<TourRevision | null>;
  create(tenantId: string, contentId: string): Promise<CreateTourOutcome>;
  /** `expectedEdit` null: no draft open yet (a copy of the published revision is opened). */
  addScene(
    tenantId: string,
    tourId: string,
    expectedEdit: number | null,
    panoramaVersionId: string,
    title: string,
  ): Promise<TourEditOutcome>;
  updateScene(
    tenantId: string,
    tourId: string,
    expectedEdit: number | null,
    sceneId: string,
    changes: SceneChanges,
  ): Promise<TourEditOutcome>;
  moveScene(
    tenantId: string,
    tourId: string,
    expectedEdit: number | null,
    sceneId: string,
    position: number,
  ): Promise<TourEditOutcome>;
  removeScene(
    tenantId: string,
    tourId: string,
    expectedEdit: number | null,
    sceneId: string,
  ): Promise<TourEditOutcome>;
  setEntryScene(
    tenantId: string,
    tourId: string,
    expectedEdit: number | null,
    sceneId: string,
  ): Promise<TourEditOutcome>;
  publish(tenantId: string, tourId: string, expectedEdit: number): Promise<PublishTourOutcome>;
  restore(tenantId: string, tourId: string, revisionId: string): Promise<RestoreTourOutcome>;
  discardDraft(tenantId: string, tourId: string, expectedEdit: number): Promise<DiscardTourOutcome>;
  addHotspot(
    tenantId: string,
    tourId: string,
    expectedEdit: number | null,
    sceneId: string,
    hotspot: NewHotspot,
  ): Promise<TourEditOutcome>;
  updateHotspot(
    tenantId: string,
    tourId: string,
    expectedEdit: number | null,
    hotspotId: string,
    changes: HotspotChanges,
  ): Promise<TourEditOutcome>;
  removeHotspot(
    tenantId: string,
    tourId: string,
    expectedEdit: number | null,
    hotspotId: string,
  ): Promise<TourEditOutcome>;
  /** Destinations and events a "go to another tour" point can lead to (never its own). */
  hotspotTargets(tenantId: string, tourId: string): Promise<HotspotTargetOption[]>;
}

/** Content that can get a tour (from the destinations and the agenda). */
export interface TourCandidate {
  readonly contentId: string;
  readonly kind: TourContentKind;
  readonly title: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isEdit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1);
}

export async function loadTours(
  membership: OrganizationMembership,
  deps: {
    readonly tours: Pick<TourRepository, "list">;
    readonly candidates: () => Promise<readonly TourCandidate[]>;
  },
): Promise<{
  readonly tours: readonly TourListEntry[];
  readonly candidates: readonly TourCandidate[];
  readonly canEdit: boolean;
}> {
  const [tours, all] = await Promise.all([deps.tours.list(membership.tenantId), deps.candidates()]);
  const taken = new Set(tours.map((tour) => tour.contentId));
  return {
    tours,
    candidates: all.filter((candidate) => !taken.has(candidate.contentId)),
    canEdit: canEditContent(membership.role),
  };
}

export async function createTour(
  membership: OrganizationMembership,
  contentId: unknown,
  tours: Pick<TourRepository, "create">,
): Promise<CreateTourOutcome> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (!isId(contentId)) return { status: "not_found" };
  return tours.create(membership.tenantId, contentId);
}

export interface HotspotPhotoCard extends ImageReference {
  readonly previewUrl: string | null;
}

export interface TourHotspotCard extends Omit<TourHotspot, "gallery"> {
  readonly gallery: readonly HotspotPhotoCard[];
  /** Model points: the poster visitors see while it loads. */
  readonly posterUrl: string | null;
}

export interface TourSceneCard extends Omit<TourScene, "hotspots"> {
  /** Signed, short-lived URLs (the panoramas stay private until P4 · Paso 3). */
  readonly previewUrl: string | null;
  readonly imageUrl: string | null;
  readonly hotspots: readonly TourHotspotCard[];
}

/** A ready 3D model a point can open. */
export interface TourModelOption {
  readonly versionId: string;
  readonly posterUrl: string | null;
  readonly hasPoster: boolean;
  readonly triangles: number | null;
  readonly createdAt: string;
}

export interface TourPanoramaOption {
  readonly versionId: string;
  readonly previewUrl: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly createdAt: string;
}

export interface TourEditor {
  readonly record: TourRecord;
  /** What the editor shows: the open draft, else the published revision. */
  readonly revision: TourRevision;
  readonly scenes: readonly TourSceneCard[];
  /** null: no draft open (the next edit opens one). */
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  readonly publicationIssues: readonly TourPublicationIssue[];
  /** Ready panoramas of the municipality that are not scenes of this revision yet. */
  readonly options: readonly TourPanoramaOption[];
  /** Ready 3D models of the municipality (for model points). */
  readonly models: readonly TourModelOption[];
  /** Where a "go to another tour" point can lead. */
  readonly targets: readonly HotspotTargetOption[];
}

export async function loadTourEditor(
  membership: OrganizationMembership,
  tourId: unknown,
  deps: {
    readonly tours: Pick<TourRepository, "find" | "hotspotTargets">;
    readonly panoramas: Pick<PanoramaRepository, "list">;
    readonly models: Pick<ModelRepository, "list">;
    readonly media: Pick<MediaRepository, "signedPreviewUrls">;
  },
): Promise<TourEditor | null> {
  if (!isId(tourId)) return null;
  const record = await deps.tours.find(membership.tenantId, tourId);
  const revision = record?.draft ?? record?.published;
  if (!record || !revision) return null;

  const canEdit = canEditContent(membership.role);
  const used = new Set(revision.scenes.map((scene) => scene.panorama.versionId));
  const [panoramas, models, targets] = canEdit
    ? await Promise.all([
        deps.panoramas.list(membership.tenantId),
        deps.models.list(membership.tenantId),
        deps.tours.hotspotTargets(membership.tenantId, tourId),
      ])
    : [[], [], []];
  const ready = panoramas.filter(
    (view) => view.status === "ready" && view.manifest !== null && !used.has(view.versionId),
  );
  const readyModels = models.filter((view) => view.status === "ready" && view.manifest !== null);
  const posterPath = (assetId: string, version: number, file: string) =>
    imageVersionPrefix(membership.tenantId, assetId, version) + MODEL_FOLDER + file;
  const photoPath = (image: ImageReference) =>
    contentImagePath(membership.tenantId, image, "w480.webp");
  const hotspots = revision.scenes.flatMap((scene) => scene.hotspots);

  const folder = (assetId: string, version: number) =>
    `${membership.tenantId}/${assetId}/${version}/${PANORAMA_FOLDER}`;
  const paths = [
    ...revision.scenes.flatMap((scene) =>
      scene.panorama.manifest
        ? [
            folder(scene.panorama.assetId, scene.panorama.version) +
              scene.panorama.manifest.preview.file,
            folder(scene.panorama.assetId, scene.panorama.version) +
              scene.panorama.manifest.image.file,
          ]
        : [],
    ),
    ...ready.flatMap((view) =>
      view.manifest ? [folder(view.assetId, view.version) + view.manifest.preview.file] : [],
    ),
    ...hotspots.flatMap((hotspot) => hotspot.gallery.map(photoPath)),
    ...hotspots.flatMap((hotspot) =>
      hotspot.model?.manifest?.poster
        ? [
            posterPath(
              hotspot.model.assetId,
              hotspot.model.version,
              hotspot.model.manifest.poster.file,
            ),
          ]
        : [],
    ),
    ...readyModels.flatMap((view) =>
      view.manifest?.poster
        ? [posterPath(view.assetId, view.version, view.manifest.poster.file)]
        : [],
    ),
  ];
  const signed =
    paths.length > 0 ? await deps.media.signedPreviewUrls(paths) : new Map<string, string>();

  return {
    record,
    revision,
    scenes: revision.scenes.map((scene) => {
      const base = folder(scene.panorama.assetId, scene.panorama.version);
      return {
        ...scene,
        previewUrl: scene.panorama.manifest
          ? (signed.get(base + scene.panorama.manifest.preview.file) ?? null)
          : null,
        imageUrl: scene.panorama.manifest
          ? (signed.get(base + scene.panorama.manifest.image.file) ?? null)
          : null,
        hotspots: scene.hotspots.map((hotspot) => ({
          ...hotspot,
          gallery: hotspot.gallery.map((image) => ({
            ...image,
            previewUrl: signed.get(photoPath(image)) ?? null,
          })),
          posterUrl: hotspot.model?.manifest?.poster
            ? (signed.get(
                posterPath(
                  hotspot.model.assetId,
                  hotspot.model.version,
                  hotspot.model.manifest.poster.file,
                ),
              ) ?? null)
            : null,
        })),
      };
    }),
    editCount: record.draft?.editCount ?? null,
    canEdit,
    canPublish: canPublishContent(membership.role),
    publicationIssues: tourPublicationIssues(revision),
    options: ready.map((view) => ({
      versionId: view.versionId,
      previewUrl: view.manifest
        ? (signed.get(folder(view.assetId, view.version) + view.manifest.preview.file) ?? null)
        : null,
      width: view.width,
      height: view.height,
      createdAt: view.createdAt,
    })),
    models: readyModels.map((view) => ({
      versionId: view.versionId,
      posterUrl: view.manifest?.poster
        ? (signed.get(posterPath(view.assetId, view.version, view.manifest.poster.file)) ?? null)
        : null,
      hasPoster: Boolean(view.manifest?.poster),
      triangles: view.manifest?.model.triangles ?? null,
      createdAt: view.createdAt,
    })),
    targets,
  };
}

export type SceneEditResult =
  TourEditOutcome | { readonly status: "rejected"; readonly issues: readonly SceneIssue[] };

/** Adds a ready panorama as the last scene (the first one becomes the entry). */
export async function addTourScene(
  membership: OrganizationMembership,
  input: {
    readonly tourId: unknown;
    readonly expectedEdit: unknown;
    readonly panoramaVersionId: unknown;
    readonly title: unknown;
  },
  tours: Pick<TourRepository, "addScene">,
): Promise<SceneEditResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (!isId(input.tourId) || !isId(input.panoramaVersionId) || !isEdit(input.expectedEdit)) {
    return { status: "not_found" };
  }
  const title = parseSceneTitle(input.title);
  if ("issue" in title) return { status: "rejected", issues: [title.issue] };
  return tours.addScene(
    membership.tenantId,
    input.tourId,
    input.expectedEdit,
    input.panoramaVersionId,
    title.title,
  );
}

/** Saves only the fields the form sent (title, description, initial view). */
export async function updateTourScene(
  membership: OrganizationMembership,
  input: {
    readonly tourId: unknown;
    readonly expectedEdit: unknown;
    readonly sceneId: unknown;
    readonly changes: Readonly<Record<string, unknown>>;
  },
  tours: Pick<TourRepository, "updateScene">,
): Promise<SceneEditResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (!isId(input.tourId) || !isId(input.sceneId) || !isEdit(input.expectedEdit)) {
    return { status: "not_found" };
  }
  const parsed = parseSceneChanges(input.changes);
  if (!parsed.ok) return { status: "rejected", issues: parsed.issues };
  return tours.updateScene(
    membership.tenantId,
    input.tourId,
    input.expectedEdit,
    input.sceneId,
    parsed.changes,
  );
}

type SceneIntent =
  | { readonly kind: "move"; readonly position: unknown }
  | { readonly kind: "remove" }
  | { readonly kind: "entry" };

/** Moves, removes a scene or makes it the entry. */
export async function changeTourScene(
  membership: OrganizationMembership,
  input: { readonly tourId: unknown; readonly expectedEdit: unknown; readonly sceneId: unknown },
  intent: SceneIntent,
  tours: Pick<TourRepository, "moveScene" | "removeScene" | "setEntryScene">,
): Promise<TourEditOutcome> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (!isId(input.tourId) || !isId(input.sceneId) || !isEdit(input.expectedEdit)) {
    return { status: "not_found" };
  }
  const args = [membership.tenantId, input.tourId, input.expectedEdit, input.sceneId] as const;
  switch (intent.kind) {
    case "move": {
      const position = intent.position;
      if (typeof position !== "number" || !Number.isInteger(position) || position < 0) {
        return { status: "invalid", reason: "shape" };
      }
      return tours.moveScene(...args, position);
    }
    case "remove":
      return tours.removeScene(...args);
    case "entry":
      return tours.setEntryScene(...args);
  }
}

export async function publishTour(
  membership: OrganizationMembership,
  input: { readonly tourId: unknown; readonly expectedEdit: unknown },
  tours: Pick<TourRepository, "publish">,
): Promise<PublishTourOutcome> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  if (
    !isId(input.tourId) ||
    typeof input.expectedEdit !== "number" ||
    !isEdit(input.expectedEdit)
  ) {
    return { status: "not_found" };
  }
  return tours.publish(membership.tenantId, input.tourId, input.expectedEdit);
}

export async function restoreTourRevision(
  membership: OrganizationMembership,
  input: { readonly tourId: unknown; readonly revisionId: unknown },
  tours: Pick<TourRepository, "restore">,
): Promise<RestoreTourOutcome> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  if (!isId(input.tourId) || !isId(input.revisionId)) return { status: "not_found" };
  return tours.restore(membership.tenantId, input.tourId, input.revisionId);
}

export async function discardTourDraft(
  membership: OrganizationMembership,
  input: { readonly tourId: unknown; readonly expectedEdit: unknown },
  tours: Pick<TourRepository, "discardDraft">,
): Promise<DiscardTourOutcome> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (
    !isId(input.tourId) ||
    typeof input.expectedEdit !== "number" ||
    !isEdit(input.expectedEdit)
  ) {
    return { status: "not_found" };
  }
  return tours.discardDraft(membership.tenantId, input.tourId, input.expectedEdit);
}

export type HotspotEditResult =
  TourEditOutcome | { readonly status: "rejected"; readonly issues: readonly HotspotIssue[] };

/** Adds a point to a scene, with its kind's target (validated here and in the database). */
export async function addTourHotspot(
  membership: OrganizationMembership,
  input: {
    readonly tourId: unknown;
    readonly expectedEdit: unknown;
    readonly sceneId: unknown;
    readonly hotspot: Readonly<Record<string, unknown>>;
  },
  tours: Pick<TourRepository, "addHotspot">,
): Promise<HotspotEditResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (!isId(input.tourId) || !isId(input.sceneId) || !isEdit(input.expectedEdit)) {
    return { status: "not_found" };
  }
  const parsed = parseNewHotspot(input.hotspot ?? {});
  if (!parsed.ok) return { status: "rejected", issues: parsed.issues };
  return tours.addHotspot(
    membership.tenantId,
    input.tourId,
    input.expectedEdit,
    input.sceneId,
    parsed.hotspot,
  );
}

/** Saves only the fields the form touched; the kind never changes (RC-01). */
export async function updateTourHotspot(
  membership: OrganizationMembership,
  input: {
    readonly tourId: unknown;
    readonly expectedEdit: unknown;
    readonly hotspotId: unknown;
    readonly kind: HotspotKind;
    readonly changes: Readonly<Record<string, unknown>>;
  },
  tours: Pick<TourRepository, "updateHotspot">,
): Promise<HotspotEditResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (!isId(input.tourId) || !isId(input.hotspotId) || !isEdit(input.expectedEdit)) {
    return { status: "not_found" };
  }
  const parsed = parseHotspotChanges(input.kind, input.changes ?? {});
  if (!parsed.ok) return { status: "rejected", issues: parsed.issues };
  return tours.updateHotspot(
    membership.tenantId,
    input.tourId,
    input.expectedEdit,
    input.hotspotId,
    parsed.changes,
  );
}

export async function removeTourHotspot(
  membership: OrganizationMembership,
  input: { readonly tourId: unknown; readonly expectedEdit: unknown; readonly hotspotId: unknown },
  tours: Pick<TourRepository, "removeHotspot">,
): Promise<TourEditOutcome> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  if (!isId(input.tourId) || !isId(input.hotspotId) || !isEdit(input.expectedEdit)) {
    return { status: "not_found" };
  }
  return tours.removeHotspot(
    membership.tenantId,
    input.tourId,
    input.expectedEdit,
    input.hotspotId,
  );
}
