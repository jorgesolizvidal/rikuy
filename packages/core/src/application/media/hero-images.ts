import type { JobLease } from "../jobs/ports";

/**
 * The hero versions of a content photo uploaded before they existed (ADR-070), read under
 * the job's lease. `published`: its derivatives are public, so the hero versions must be
 * copied there too. Null: the version is gone or is not a ready content photo.
 */
export interface HeroImageSource {
  readonly tenantId: string;
  readonly assetId: string;
  readonly version: number;
  readonly originalPath: string;
  readonly published: boolean;
}

export interface HeroImageStore {
  source(lease: JobLease): Promise<HeroImageSource | null | "lease_lost">;
  /**
   * After the files are stored: the ledger checks they are there and measures the version
   * again for its quota. "missing": the private files are not there (a retry stores them).
   */
  complete(lease: JobLease): Promise<"done" | "gone" | "missing" | "lease_lost">;
}
