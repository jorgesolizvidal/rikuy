import type { UsageResource } from "../../contracts/usage";
import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import type { PanoramaManifest } from "../../contracts/panorama";
import type { JobStatus } from "../../contracts/jobs";
import { PANORAMA_RULES, type PanoramaProblem } from "../../domain/media/panorama";
import { checkDeclaredImage } from "../../domain/media/rules";
import type { DerivedFile, MediaRepository, ReadyImageMetadata } from "./ports";
import type { JobLease } from "../jobs/ports";
import type { PanoramaPlan, PanoramaLevelPlan } from "../../domain/media/panorama";

/** Who may upload panoramas (tours are edited by the same people as destinations). */
export const PANORAMA_UPLOADERS: readonly MembershipRole[] = ["owner", "admin", "editor"];

/** Folder of a version's renditions, inside the version prefix. */
export const PANORAMA_FOLDER = "panorama/";

export type PanoramaStatus = "uploading" | "processing" | "ready" | "rejected";

export interface PanoramaView {
  readonly versionId: string;
  readonly assetId: string;
  readonly version: number;
  readonly status: PanoramaStatus;
  readonly declaredBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** Why it was rejected (a known problem, or "unreadable" for anything else). */
  readonly problem: PanoramaProblem | null;
  readonly manifest: PanoramaManifest | null;
  readonly createdAt: string;
  readonly readyAt: string | null;
  /** The processing job, when there is one. */
  readonly job: {
    readonly status: JobStatus;
    readonly attempts: number;
    readonly maxAttempts: number;
    readonly lastErrorCode: string | null;
  } | null;
}

export type PanoramaSubmitOutcome =
  "processing" | "ready" | "rejected" | "not_uploaded" | "not_found" | "forbidden";

/** The municipality's panoramas, with the signed-in user's session. */
export interface PanoramaRepository {
  list(tenantId: string): Promise<PanoramaView[]>;
  /** The browser finished uploading: move to processing and enqueue the job (one transaction). */
  submit(tenantId: string, versionId: string): Promise<PanoramaSubmitOutcome>;
}

export type RequestPanoramaUploadResult =
  | {
      readonly status: "upload";
      readonly versionId: string;
      readonly uploadUrl: string;
      readonly mime: string;
    }
  | { readonly status: "invalid"; readonly problem: PanoramaProblem }
  | { readonly status: "forbidden" | "rate_limited" }
  | { readonly status: "over_quota"; readonly resource: UsageResource };

/** Step 1: reserve a panorama version and hand the browser a one-time upload URL. */
export async function requestPanoramaUpload(
  membership: OrganizationMembership,
  input: { readonly mime: unknown; readonly bytes: unknown },
  media: MediaRepository,
): Promise<RequestPanoramaUploadResult> {
  if (!PANORAMA_UPLOADERS.includes(membership.role)) return { status: "forbidden" };
  const problem = checkDeclaredImage(PANORAMA_RULES, input.mime, input.bytes);
  if (problem !== null) return { status: "invalid", problem };

  const mime = input.mime as "image/png" | "image/jpeg" | "image/webp";
  const created = await media.createImageUpload(
    membership.tenantId,
    "panorama",
    mime,
    input.bytes as number,
  );
  if (created.status === "invalid") return { status: "invalid", problem: "too_heavy" };
  if (created.status === "over_quota") return created;
  if (created.status !== "created") return { status: created.status };
  return {
    status: "upload",
    versionId: created.upload.versionId,
    uploadUrl: await media.signedUploadUrl(created.upload.originalPath),
    mime,
  };
}

/**
 * Step 2: the upload finished. Processing happens in the background (a durable job), so
 * the page can be closed; the list shows the progress.
 */
export async function submitPanorama(
  membership: OrganizationMembership,
  versionId: unknown,
  panoramas: PanoramaRepository,
): Promise<PanoramaSubmitOutcome> {
  if (!PANORAMA_UPLOADERS.includes(membership.role)) return "forbidden";
  if (typeof versionId !== "string" || !/^[0-9a-f-]{36}$/u.test(versionId)) return "not_found";
  return panoramas.submit(membership.tenantId, versionId);
}

export interface PanoramaCard extends PanoramaView {
  /** Signed, short-lived URLs of the renditions (private until a tour is published). */
  readonly previewUrl: string | null;
  readonly imageUrl: string | null;
}

/** The list for the panel, with signed URLs for the renditions of ready panoramas. */
export async function loadPanoramas(
  membership: OrganizationMembership,
  deps: { readonly panoramas: PanoramaRepository; readonly media: MediaRepository },
): Promise<{ readonly cards: readonly PanoramaCard[]; readonly canUpload: boolean }> {
  const views = await deps.panoramas.list(membership.tenantId);
  const folder = (view: PanoramaView) =>
    `${membership.tenantId}/${view.assetId}/${view.version}/${PANORAMA_FOLDER}`;
  const paths = views.flatMap((view) =>
    view.manifest
      ? [folder(view) + view.manifest.preview.file, folder(view) + view.manifest.image.file]
      : [],
  );
  const signed =
    paths.length > 0 ? await deps.media.signedPreviewUrls(paths) : new Map<string, string>();
  return {
    canUpload: PANORAMA_UPLOADERS.includes(membership.role),
    cards: views.map((view) => ({
      ...view,
      previewUrl: view.manifest
        ? (signed.get(folder(view) + view.manifest.preview.file) ?? null)
        : null,
      imageUrl: view.manifest
        ? (signed.get(folder(view) + view.manifest.image.file) ?? null)
        : null,
    })),
  };
}

// ── The pipeline's ports (worker side) ────────────────────────────────────────

export interface PanoramaSource {
  readonly status: PanoramaStatus;
  readonly originalPath: string;
  readonly declaredMime: string;
  /** {tenant}/{asset}/{version}/ */
  readonly prefix: string;
}

/** worker_api for media.process_panorama, always under the job's lease. */
export interface PanoramaStore {
  source(lease: JobLease): Promise<PanoramaSource | "not_found" | "lease_lost">;
  complete(
    lease: JobLease,
    metadata: ReadyImageMetadata,
    manifest: PanoramaManifest,
  ): Promise<"ready" | "already_settled" | "not_found" | "lease_lost">;
  reject(
    lease: JobLease,
    problem: PanoramaProblem,
  ): Promise<"rejected" | "already_settled" | "not_found" | "lease_lost">;
}

export interface RenderedImage {
  readonly file: DerivedFile;
  readonly width: number;
  readonly height: number;
}

/** Renders the files of a plan from the original bytes (sharp in @rikuy/db). */
export interface PanoramaRenderer {
  preview(original: Uint8Array, plan: PanoramaPlan): Promise<RenderedImage>;
  image(original: Uint8Array, plan: PanoramaPlan): Promise<RenderedImage>;
  /** The tiles of one level, named `{col}_{row}.webp`. */
  tiles(original: Uint8Array, level: PanoramaLevelPlan): Promise<DerivedFile[]>;
}
