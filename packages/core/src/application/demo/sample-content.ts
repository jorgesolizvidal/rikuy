import type { GeoPoint, ImageReference } from "../../contracts/destination";
import type { EventDocument } from "../../contracts/event";
import type { OrganizationMembership } from "../../contracts/organization";
import type { UsageResource } from "../../contracts/usage";
import { parseMarkup } from "../../domain/content/markup";
import {
  fillSampleText,
  offsetPoint,
  SAMPLE_DESTINATIONS,
  SAMPLE_EVENTS,
  SAMPLE_PANORAMAS,
  SAMPLE_TOUR_DESTINATION,
  sampleEventDate,
  type SampleScene,
} from "../../domain/demo/sample-template";
import { parseCoordinates } from "../../domain/geo/coordinates";
import { createDestination, publishDestination } from "../content/destinations";
import { createEvent, publishEvent } from "../content/events";
import type { ContentRepository } from "../content/ports";
import { confirmContentImageUpload, requestContentImageUpload } from "../media/content-images";
import { requestPanoramaUpload, submitPanorama, type PanoramaRepository } from "../media/panoramas";
import type { ImageProcessor, MediaAdmin, MediaRepository } from "../media/ports";
import {
  addTourHotspot,
  addTourScene,
  createTour,
  publishTour,
  type TourRepository,
} from "../tours/tours";

/**
 * Sample content of a commercial demo (ADR-034). Only the owner or an administrator of a
 * municipality the operator marked as a demo can load it. It goes through the same use
 * cases as the panel (authorization, validation, quotas, audit): nothing here writes
 * anything the person could not write by hand.
 */

/** Draws the illustrations (no photo of any real place). */
export interface SampleImageRenderer {
  /** A JPEG photo of 1600 × 1067 px; `variant` changes the light and the shapes. */
  photo(scene: SampleScene, variant: number): Promise<Uint8Array>;
  /** An equirectangular JPEG of 4096 × 2048 px whose edges meet. */
  panorama(scene: SampleScene): Promise<Uint8Array>;
}

/** Puts the bytes at a one-time signed upload URL (like the browser does). */
export type SampleUploader = (url: string, bytes: Uint8Array, mime: string) => Promise<boolean>;

export interface SampleContentDeps {
  readonly content: ContentRepository;
  readonly media: MediaRepository;
  readonly admin: MediaAdmin;
  readonly processor: ImageProcessor;
  readonly panoramas: PanoramaRepository;
  readonly renderer: SampleImageRenderer;
  readonly upload: SampleUploader;
  readonly now: () => Date;
}

export type SampleTourDeps = SampleContentDeps & { readonly tours: TourRepository };

export type SampleContentResult =
  | {
      readonly status: "loaded";
      readonly destinations: number;
      readonly events: number;
      readonly panoramas: number;
    }
  | { readonly status: "over_quota"; readonly resource: UsageResource }
  | {
      readonly status: "not_demo" | "forbidden" | "invalid_center" | "rate_limited" | "failed";
    };

const SAMPLE_ROLES = ["owner", "admin"] as const;

function mayLoad(membership: OrganizationMembership): "ok" | "not_demo" | "forbidden" {
  if (membership.demo !== true) return "not_demo";
  return (SAMPLE_ROLES as readonly string[]).includes(membership.role) ? "ok" : "forbidden";
}

class SampleStop extends Error {
  constructor(readonly result: Exclude<SampleContentResult, { status: "loaded" }>) {
    super(result.status);
  }
}

function richText(source: string, municipality: string) {
  return parseMarkup(fillSampleText(source, municipality)).blocks;
}

async function uploadPhoto(
  membership: OrganizationMembership,
  scene: SampleScene,
  variant: number,
  alt: string,
  deps: SampleContentDeps,
): Promise<ImageReference> {
  const bytes = await deps.renderer.photo(scene, variant);
  const start = await requestContentImageUpload(
    membership,
    { mime: "image/jpeg", bytes: bytes.byteLength },
    deps.media,
  );
  if (start.status === "over_quota") throw new SampleStop(start);
  if (start.status === "rate_limited") throw new SampleStop({ status: "rate_limited" });
  if (start.status !== "upload") throw new SampleStop({ status: "failed" });
  if (!(await deps.upload(start.uploadUrl, bytes, start.mime))) {
    throw new SampleStop({ status: "failed" });
  }
  const done = await confirmContentImageUpload(membership, start.versionId, deps);
  if (done.status !== "ready") throw new SampleStop({ status: "failed" });
  return { ...done.image, alt };
}

/** Uploads the sample tour's panoramas and sends them to the pipeline. */
async function uploadPanoramas(
  membership: OrganizationMembership,
  deps: SampleContentDeps,
): Promise<number> {
  let sent = 0;
  for (const { scene } of SAMPLE_PANORAMAS) {
    const bytes = await deps.renderer.panorama(scene);
    const start = await requestPanoramaUpload(
      membership,
      { mime: "image/jpeg", bytes: bytes.byteLength },
      deps.media,
    );
    if (start.status === "over_quota") throw new SampleStop(start);
    if (start.status === "rate_limited") throw new SampleStop({ status: "rate_limited" });
    if (start.status !== "upload") throw new SampleStop({ status: "failed" });
    if (!(await deps.upload(start.uploadUrl, bytes, start.mime))) {
      throw new SampleStop({ status: "failed" });
    }
    const submitted = await submitPanorama(membership, start.versionId, deps.panoramas);
    if (submitted !== "processing" && submitted !== "ready") {
      throw new SampleStop({ status: "failed" });
    }
    sent += 1;
  }
  return sent;
}

/**
 * Loads the sample destinations and events around `center` (coordinates as people paste
 * them), with their illustrations, and publishes them; then sends the tour's panoramas to
 * the pipeline. Items that already exist (by address) are left alone, so running it again
 * after a failure completes what is missing and never duplicates anything.
 */
export async function loadSampleContent(
  membership: OrganizationMembership,
  input: { readonly center: unknown },
  deps: SampleContentDeps,
): Promise<SampleContentResult> {
  const allowed = mayLoad(membership);
  if (allowed !== "ok") return { status: allowed };
  const center = typeof input.center === "string" ? parseCoordinates(input.center) : null;
  if (center === null) return { status: "invalid_center" };
  const name = membership.displayName;

  try {
    const existing = await deps.content.listDestinations(membership.tenantId);
    const ids = new Map(existing.map((entry) => [entry.slug, entry.contentId]));
    const places = new Map<string, GeoPoint>();
    let destinations = 0;
    let panoramas = 0;

    for (const item of SAMPLE_DESTINATIONS) {
      const location = offsetPoint(center, item.offset.north, item.offset.east);
      places.set(item.slug, location);
      if (ids.has(item.slug)) continue;
      const created = await createDestination(
        membership,
        { title: item.title, slug: item.slug },
        deps.content,
      );
      if (created.status !== "created") throw new SampleStop({ status: "failed" });
      ids.set(item.slug, created.contentId);
      const draft = await deps.content.findDestination(membership.tenantId, created.contentId);
      const cover = await uploadPhoto(membership, item.scene, 1, item.alt, deps);
      const photo = await uploadPhoto(membership, item.scene, 2, item.galleryAlt, deps);
      const published = await publishDestination(
        membership,
        created.contentId,
        {
          title: item.title,
          summary: fillSampleText(item.summary, name),
          body: richText(item.body, name),
          location,
          cover,
          gallery: [photo],
        },
        draft?.draft?.editCount ?? null,
        deps.content,
        deps.admin,
      );
      if (published.status !== "published") throw new SampleStop({ status: "failed" });
      destinations += 1;
      if (item.slug === SAMPLE_TOUR_DESTINATION) {
        panoramas = await uploadPanoramas(membership, deps);
      }
    }

    const events = await deps.content.listEvents(membership.tenantId);
    const eventSlugs = new Set(events.map((entry) => entry.slug));
    let createdEvents = 0;
    for (const item of SAMPLE_EVENTS) {
      if (eventSlugs.has(item.slug)) continue;
      const venueId = ids.get(item.venue) ?? null;
      const location = places.get(item.venue) ?? center;
      const created = await createEvent(
        membership,
        { title: item.title, slug: item.slug },
        deps.content,
      );
      if (created.status !== "created") throw new SampleStop({ status: "failed" });
      const draft = await deps.content.findEvent(membership.tenantId, created.contentId);
      const day = sampleEventDate(deps.now(), item.inDays, item.weekday);
      const cover = await uploadPhoto(membership, item.scene, 1, item.alt, deps);
      const document: EventDocument = {
        title: item.title,
        summary: fillSampleText(item.summary, name),
        body: richText(item.body, name),
        location,
        cover,
        gallery: [],
        schedule: { allDay: false, start: `${day}T${item.start}`, end: `${day}T${item.end}` },
        venueId,
      };
      const published = await publishEvent(
        membership,
        created.contentId,
        document,
        draft?.draft?.editCount ?? null,
        deps.content,
        deps.admin,
      );
      if (published.status !== "published") throw new SampleStop({ status: "failed" });
      createdEvents += 1;
    }

    return { status: "loaded", destinations, events: createdEvents, panoramas };
  } catch (error) {
    if (error instanceof SampleStop) return error.result;
    throw error;
  }
}

/** Where the demo stands, for the panel card. */
export interface SampleContentStatus {
  /** Every sample destination and event exists. */
  readonly loaded: boolean;
  /** Some exist (a load that stopped half way: loading again completes it). */
  readonly partial: boolean;
  /**
   * none: nothing loaded · processing: the panoramas are still being processed ·
   * ready: «Armar el tour de muestra» · built: the tour exists · missing: no panorama
   * left to use (building uploads them again).
   */
  readonly tour: "none" | "processing" | "ready" | "built" | "missing";
}

export async function loadSampleContentStatus(
  membership: OrganizationMembership,
  deps: {
    readonly content: Pick<ContentRepository, "listDestinations" | "listEvents">;
    readonly tours: Pick<TourRepository, "list">;
    readonly panoramas: Pick<PanoramaRepository, "list">;
  },
): Promise<SampleContentStatus | null> {
  if (mayLoad(membership) !== "ok") return null;
  const [destinations, events, tours, panoramas] = await Promise.all([
    deps.content.listDestinations(membership.tenantId),
    deps.content.listEvents(membership.tenantId),
    deps.tours.list(membership.tenantId),
    deps.panoramas.list(membership.tenantId),
  ]);
  const slugs = new Set([...destinations, ...events].map((entry) => entry.slug));
  const all = [...SAMPLE_DESTINATIONS, ...SAMPLE_EVENTS].map((item) => item.slug);
  const present = all.filter((slug) => slugs.has(slug)).length;
  const hasPlace = slugs.has(SAMPLE_TOUR_DESTINATION);
  const built = tours.some(
    (tour) => tour.contentKind === "destination" && tour.contentSlug === SAMPLE_TOUR_DESTINATION,
  );
  const ready = panoramas.filter((panorama) => panorama.status === "ready").length;
  const processing = panoramas.filter(
    (panorama) => panorama.status === "processing" || panorama.status === "uploading",
  ).length;
  const tour = !hasPlace
    ? "none"
    : built
      ? "built"
      : ready >= SAMPLE_PANORAMAS.length
        ? "ready"
        : processing > 0
          ? "processing"
          : "missing";
  return { loaded: present === all.length, partial: present > 0 && present < all.length, tour };
}

export type SampleTourResult =
  | { readonly status: "built" }
  | { readonly status: "processing"; readonly uploaded: number }
  | { readonly status: "over_quota"; readonly resource: UsageResource }
  | {
      readonly status: "not_demo" | "forbidden" | "no_place" | "exists" | "rate_limited" | "failed";
    };

const SAMPLE_INFO = [
  "*Texto de muestra.* En cada escena se pueden poner puntos con información, fotos, modelos 3D o enlaces a otros recorridos.",
].join("\n\n");

/**
 * Builds and publishes the sample tour of the main square with the two most recent ready
 * panoramas: two scenes joined by arrows both ways and an information point. When there
 * are no panoramas to use (and none processing), it uploads them again and says so.
 */
export async function buildSampleTour(
  membership: OrganizationMembership,
  deps: SampleTourDeps,
): Promise<SampleTourResult> {
  const allowed = mayLoad(membership);
  if (allowed !== "ok") return { status: allowed };
  try {
    const destinations = await deps.content.listDestinations(membership.tenantId);
    const place = destinations.find((entry) => entry.slug === SAMPLE_TOUR_DESTINATION);
    if (!place || place.status === "draft") return { status: "no_place" };

    const ready = (await deps.panoramas.list(membership.tenantId))
      .filter((panorama) => panorama.status === "ready")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, SAMPLE_PANORAMAS.length)
      .reverse();
    if (ready.length < SAMPLE_PANORAMAS.length) {
      const pending = (await deps.panoramas.list(membership.tenantId)).some(
        (panorama) => panorama.status === "processing" || panorama.status === "uploading",
      );
      return {
        status: "processing",
        uploaded: pending ? 0 : await uploadPanoramas(membership, deps),
      };
    }

    const created = await createTour(membership, place.contentId, deps.tours);
    if (created.status === "exists") return { status: "exists" };
    if (created.status !== "created") return { status: "failed" };
    const tourId = created.tourId;

    // A new tour opens with an empty draft: its edit number comes with it.
    let edit: number | null =
      (await deps.tours.find(membership.tenantId, tourId))?.draft?.editCount ?? null;
    for (const [index, panorama] of ready.entries()) {
      const added = await addTourScene(
        membership,
        {
          tourId,
          expectedEdit: edit,
          panoramaVersionId: panorama.versionId,
          title: SAMPLE_PANORAMAS[index]?.title ?? "Escena",
        },
        deps.tours,
      );
      if (added.status !== "saved") return { status: "failed" };
      edit = added.editCount;
    }

    const record = await deps.tours.find(membership.tenantId, tourId);
    const scenes = record?.draft?.scenes ?? [];
    const [first, second] = scenes;
    if (!first || !second) return { status: "failed" };
    const points = [
      {
        sceneId: first.sceneId,
        hotspot: {
          kind: "info",
          title: "Sobre este lugar",
          position: { yaw: -0.6, pitch: -0.05 },
          body: fillSampleText(SAMPLE_INFO, membership.displayName),
        },
      },
      {
        sceneId: first.sceneId,
        hotspot: {
          kind: "scene",
          title: `Ir a ${second.title}`,
          position: { yaw: 0.9, pitch: -0.15 },
          targetSceneId: second.sceneId,
        },
      },
      {
        sceneId: second.sceneId,
        hotspot: {
          kind: "scene",
          title: `Volver a ${first.title}`,
          position: { yaw: -2.2, pitch: -0.15 },
          targetSceneId: first.sceneId,
        },
      },
    ];
    for (const point of points) {
      const added = await addTourHotspot(
        membership,
        { tourId, expectedEdit: edit, sceneId: point.sceneId, hotspot: point.hotspot },
        deps.tours,
      );
      if (added.status !== "saved") return { status: "failed" };
      edit = added.editCount;
    }

    const published = await publishTour(
      membership,
      { tourId, expectedEdit: edit },
      { tours: deps.tours, media: deps.admin },
    );
    return published.status === "published" ? { status: "built" } : { status: "failed" };
  } catch (error) {
    if (error instanceof SampleStop) {
      const result = error.result;
      if (result.status === "over_quota") return result;
      if (result.status === "rate_limited") return { status: "rate_limited" };
      return { status: "failed" };
    }
    throw error;
  }
}
