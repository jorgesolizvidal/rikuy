import type { JobLease } from "../jobs/ports";

/**
 * The ledger's view of an abandoned image upload (worker_api), always through the lease
 * of the job that is about it: the version is the job's subject, checked against the job's
 * own municipality, never taken from the payload.
 */
export interface AbandonedUploadStore {
  inspect(
    lease: JobLease,
  ): Promise<{ readonly abandoned: boolean; readonly originalPath: string | null } | "lease_lost">;
  markAbandoned(
    lease: JobLease,
  ): Promise<"marked" | "already_settled" | "not_found" | "lease_lost">;
}
