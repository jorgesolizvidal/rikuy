import type { TenantPresentation } from "../../contracts/presentation";

/** Latest sealed version currently served by the portal. */
export interface PublishedConfigRecord {
  readonly configId: string;
  readonly version: number;
  /** Raw stored value; parsed by the use case, never trusted blindly. */
  readonly presentation: unknown;
  readonly sealedAt: string;
}

/** The single open draft of a tenant (at most one exists). */
export interface DraftConfigRecord {
  readonly configId: string;
  readonly version: number;
  /** Optimistic-concurrency token: every save increments it. */
  readonly revision: number;
  readonly presentation: unknown;
  readonly updatedAt: string;
}

export interface BrandingSnapshot {
  readonly published: PublishedConfigRecord | null;
  readonly draft: DraftConfigRecord | null;
  /** Canonical portal hostname when the caller may see the domain registry. */
  readonly portalHostname: string | null;
}

export type SaveDraftOutcome =
  | {
      readonly status: "saved";
      readonly configId: string;
      readonly version: number;
      readonly revision: number;
    }
  | { readonly status: "conflict" }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid" };

export type PublishOutcome =
  | { readonly status: "published"; readonly configId: string; readonly version: number }
  | { readonly status: "conflict" }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid" }
  | { readonly status: "not_found" };

/**
 * Writes run as the signed-in user (RLS + role checks in the database); the use cases
 * check roles too, so a forbidden request never reaches the network.
 */
export interface TenantConfigRepository {
  loadSnapshot(tenantId: string): Promise<BrandingSnapshot>;
  /** `expectedRevision: null` means "I expect no draft to exist yet". */
  saveDraft(
    tenantId: string,
    presentation: TenantPresentation,
    expectedRevision: number | null,
  ): Promise<SaveDraftOutcome>;
  publish(tenantId: string, configId: string, expectedRevision: number): Promise<PublishOutcome>;
}

export interface PublishedPresentationRecord {
  readonly schemaVersion: number;
  readonly presentation: unknown;
}

/** Anonymous read of a sealed, active configuration (public portal). */
export interface PublishedPresentationReader {
  findPublished(configId: string): Promise<PublishedPresentationRecord | null>;
}
