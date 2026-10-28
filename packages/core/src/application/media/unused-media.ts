import type { JobLease } from "../jobs/ports";

/**
 * Unused photos and logos (ADR-035). The ledger decides, under the job's lease, whether the
 * version is still unused; if so it rejects it at once (nothing can start using it) and
 * hands back its folder, `{tenant}/{asset}/{version}/`, whose files the runner removes from
 * both buckets. Null: used again, or gone — nothing to remove.
 */
export interface UnusedMediaStore {
  claim(lease: JobLease): Promise<string | null | "lease_lost">;
}

/** Removes every file of one version's folder in both buckets; answers how many. */
export interface MediaFolderRemover {
  removeVersionFolder(prefix: string): Promise<number>;
}
