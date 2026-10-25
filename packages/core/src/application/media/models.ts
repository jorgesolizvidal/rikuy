import type { UsageResource } from "../../contracts/usage";
import type { JobStatus } from "../../contracts/jobs";
import type {
  ColorCheck,
  ColorSuspect,
  ModelManifest,
  ModelPoster,
  ModelTextureEncoding,
  ModelTextureUsage,
} from "../../contracts/model";
import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import { inspectImage } from "../../domain/media/image";
import { checkDeclaredModel, MODEL_MIME, type ModelProblem } from "../../domain/media/model";
import type { JobLease } from "../jobs/ports";
import {
  imageVersionPrefix,
  type ImageProcessor,
  type MediaAdmin,
  type MediaRepository,
} from "./ports";

/** Who may upload models (tours are edited by the same people as destinations). */
export const MODEL_UPLOADERS: readonly MembershipRole[] = ["owner", "admin", "editor"];

/** Folder of what the pipeline makes, inside the version prefix. */
export const MODEL_FOLDER = "model/";
export const MODEL_FILE = "model.glb";
export const MODEL_POSTER_FILE = "poster.webp";
/** The panel's capture, before re-encoding (a PNG of a large canvas). */
export const MODEL_POSTER_MAX_CAPTURE_BYTES = 6 * 1024 * 1024;

export type ModelStatus = "uploading" | "processing" | "ready" | "rejected";

export interface ModelView {
  readonly versionId: string;
  readonly assetId: string;
  readonly version: number;
  readonly status: ModelStatus;
  readonly declaredBytes: number;
  /** Why it was rejected (a known problem, or "unreadable" for anything else). */
  readonly problem: ModelProblem | null;
  readonly manifest: ModelManifest | null;
  readonly createdAt: string;
  readonly readyAt: string | null;
  readonly job: {
    readonly status: JobStatus;
    readonly attempts: number;
    readonly maxAttempts: number;
    readonly lastErrorCode: string | null;
  } | null;
}

export type ModelSubmitOutcome =
  "processing" | "ready" | "rejected" | "not_uploaded" | "not_found" | "forbidden";

export type ModelPosterOutcome = "saved" | "invalid" | "not_ready" | "not_found" | "forbidden";

/** The municipality's models, with the signed-in user's session. */
export interface ModelRepository {
  list(tenantId: string): Promise<ModelView[]>;
  /** The browser finished uploading: move to processing and enqueue the job (one transaction). */
  submit(tenantId: string, versionId: string): Promise<ModelSubmitOutcome>;
  /** Records the poster stored next to the model (the database checks role and state). */
  setPoster(tenantId: string, versionId: string, poster: ModelPoster): Promise<ModelPosterOutcome>;
}

export type RequestModelUploadResult =
  | {
      readonly status: "upload";
      readonly versionId: string;
      readonly uploadUrl: string;
      readonly mime: typeof MODEL_MIME;
    }
  | { readonly status: "invalid"; readonly problem: ModelProblem }
  | { readonly status: "forbidden" | "rate_limited" }
  | { readonly status: "over_quota"; readonly resource: UsageResource };

/** Step 1: reserve a model version and hand the browser a one-time upload URL. */
export async function requestModelUpload(
  membership: OrganizationMembership,
  input: { readonly mime: unknown; readonly bytes: unknown },
  media: MediaRepository,
): Promise<RequestModelUploadResult> {
  if (!MODEL_UPLOADERS.includes(membership.role)) return { status: "forbidden" };
  const problem = checkDeclaredModel(input.mime, input.bytes);
  if (problem !== null) return { status: "invalid", problem };

  const created = await media.createImageUpload(
    membership.tenantId,
    "model",
    MODEL_MIME,
    input.bytes as number,
  );
  if (created.status === "invalid") return { status: "invalid", problem: "too_heavy" };
  if (created.status === "over_quota") return created;
  if (created.status !== "created") return { status: created.status };
  return {
    status: "upload",
    versionId: created.upload.versionId,
    uploadUrl: await media.signedUploadUrl(created.upload.originalPath),
    mime: MODEL_MIME,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Step 2: the upload finished; the optimization runs in the background (a durable job). */
export async function submitModel(
  membership: OrganizationMembership,
  versionId: unknown,
  models: ModelRepository,
): Promise<ModelSubmitOutcome> {
  if (!MODEL_UPLOADERS.includes(membership.role)) return "forbidden";
  if (typeof versionId !== "string" || !UUID.test(versionId)) return "not_found";
  return models.submit(membership.tenantId, versionId);
}

export interface ModelCard extends ModelView {
  /** Signed, short-lived URLs (private until a tour publishes the model). */
  readonly modelUrl: string | null;
  readonly posterUrl: string | null;
}

/** The list for the panel, with signed URLs for the optimized model and its poster. */
export async function loadModels(
  membership: OrganizationMembership,
  deps: { readonly models: ModelRepository; readonly media: MediaRepository },
): Promise<{ readonly cards: readonly ModelCard[]; readonly canUpload: boolean }> {
  const views = await deps.models.list(membership.tenantId);
  const folder = (view: ModelView) =>
    imageVersionPrefix(membership.tenantId, view.assetId, view.version) + MODEL_FOLDER;
  const paths = views.flatMap((view) =>
    view.manifest
      ? [
          folder(view) + view.manifest.model.file,
          ...(view.manifest.poster ? [folder(view) + view.manifest.poster.file] : []),
        ]
      : [],
  );
  const signed =
    paths.length > 0 ? await deps.media.signedPreviewUrls(paths) : new Map<string, string>();
  return {
    canUpload: MODEL_UPLOADERS.includes(membership.role),
    cards: views.map((view) => ({
      ...view,
      modelUrl: view.manifest
        ? (signed.get(folder(view) + view.manifest.model.file) ?? null)
        : null,
      posterUrl: view.manifest?.poster
        ? (signed.get(folder(view) + view.manifest.poster.file) ?? null)
        : null,
    })),
  };
}

/**
 * The poster: the panel draws the optimized model with the portal's viewer and sends the
 * capture. The server re-encodes it (WebP, no metadata), stores it next to the model and
 * the database records it, checking role, tenant and state again.
 */
export async function saveModelPoster(
  membership: OrganizationMembership,
  input: { readonly versionId: unknown; readonly capture: unknown },
  deps: {
    readonly models: ModelRepository;
    readonly media: MediaRepository;
    readonly admin: Pick<MediaAdmin, "storeDerivatives">;
    readonly processor: Pick<ImageProcessor, "modelPoster">;
  },
): Promise<ModelPosterOutcome> {
  if (!MODEL_UPLOADERS.includes(membership.role)) return "forbidden";
  const { versionId, capture } = input;
  if (typeof versionId !== "string" || !UUID.test(versionId)) return "not_found";
  if (
    !(capture instanceof Uint8Array) ||
    capture.byteLength === 0 ||
    capture.byteLength > MODEL_POSTER_MAX_CAPTURE_BYTES
  ) {
    return "invalid";
  }
  const info = inspectImage(capture);
  if (info === null || Math.min(info.width, info.height) < 64) return "invalid";

  const version = await deps.media.findVersion(versionId);
  if (!version || version.tenantId !== membership.tenantId || version.purpose !== "model") {
    return "not_found";
  }
  if (version.status !== "ready") return "not_ready";

  let poster: Awaited<ReturnType<ImageProcessor["modelPoster"]>>;
  try {
    poster = await deps.processor.modelPoster(capture);
  } catch {
    return "invalid";
  }
  const prefix = imageVersionPrefix(version.tenantId, version.assetId, version.version);
  await deps.admin.storeDerivatives(prefix + MODEL_FOLDER, [
    { ...poster.file, name: MODEL_POSTER_FILE },
  ]);
  return deps.models.setPoster(membership.tenantId, versionId, {
    file: MODEL_POSTER_FILE,
    width: poster.width,
    height: poster.height,
    bytes: poster.file.bytes.byteLength,
  });
}

// ── The pipeline's ports (worker side) ────────────────────────────────────────

export interface ModelSource {
  readonly status: ModelStatus;
  readonly originalPath: string;
  readonly declaredMime: string;
  /** {tenant}/{asset}/{version}/ */
  readonly prefix: string;
}

/** worker_api for media.process_model, always under the job's lease. */
export interface ModelStore {
  source(lease: JobLease): Promise<ModelSource | "not_found" | "lease_lost">;
  complete(
    lease: JobLease,
    original: { readonly bytes: number; readonly sha256: string },
    manifest: ModelManifest,
  ): Promise<"ready" | "already_settled" | "not_found" | "lease_lost">;
  reject(
    lease: JobLease,
    problem: ModelProblem,
  ): Promise<"rejected" | "already_settled" | "not_found" | "lease_lost">;
}

/** A texture of the prepared model (same order in every call for the same file). */
export interface ModelTexturePlan {
  readonly index: number;
  readonly name: string;
  readonly usage: ModelTextureUsage;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** False when it already is KTX2, or its image type cannot be re-encoded. */
  readonly encodable: boolean;
}

export type ModelAnalysis =
  | {
      readonly ok: true;
      readonly source: Omit<ModelManifest["source"], "bytes" | "sha256">;
      readonly textures: readonly ModelTexturePlan[];
      readonly suspects: readonly ColorSuspect[];
    }
  | { readonly ok: false; readonly problem: ModelProblem };

export interface EncodedTexture {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Measured by decoding the KTX2 and comparing it with the (resized) source. */
  readonly check: ColorCheck;
}

export interface AssembledModel {
  readonly glb: Uint8Array;
  readonly triangles: number;
  readonly vertexColors: ColorCheck | null;
  /** Every primitive kept its material's factors, modes and texture slots. */
  readonly materialsUnchanged: boolean;
}

/** Validates, encodes and assembles a GLB (glTF Transform, Meshopt, Basis in @rikuy/db). */
export interface ModelOptimizer {
  analyze(original: Uint8Array): Promise<ModelAnalysis>;
  encodeTexture(
    original: Uint8Array,
    index: number,
    encoding: Exclude<ModelTextureEncoding, "original">,
  ): Promise<EncodedTexture>;
  /** `textures`: KTX2 bytes per texture index; a missing index keeps its original image. */
  assemble(
    original: Uint8Array,
    textures: ReadonlyMap<number, Uint8Array>,
  ): Promise<AssembledModel>;
}
