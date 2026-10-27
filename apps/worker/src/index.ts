/**
 * @rikuy/worker — durable background processing (media pipeline, knowledge ingestion).
 *
 * Processors are plain functions over @rikuy/core use cases; the job runtime (ADR-019) is
 * an adapter around them, never the other way round. A runtime only claims the kinds
 * returned here, so a deployment never takes work it cannot do.
 */
import type { JobProcessor } from "@rikuy/core";

import {
  createExpireAbandonedUploadProcessor,
  type ExpireAbandonedUploadDeps,
} from "./processors/expire-abandoned-upload";
import {
  createMembershipInvitationMailProcessor,
  type MembershipInvitationMailDeps,
} from "./processors/membership-invitation-mail";
import { createProcessModelProcessor, type ProcessModelDeps } from "./processors/process-model";
import {
  createProcessPanoramaProcessor,
  type ProcessPanoramaDeps,
} from "./processors/process-panorama";
import { probeProcessor } from "./processors/probe";

export {
  createExpireAbandonedUploadProcessor,
  createMembershipInvitationMailProcessor,
  createProcessModelProcessor,
  createProcessPanoramaProcessor,
  probeProcessor,
};
export type {
  ExpireAbandonedUploadDeps,
  MembershipInvitationMailDeps,
  ProcessModelDeps,
  ProcessPanoramaDeps,
};

/** What the processors need from the platform (adapters built by the runtime). */
export type ProcessorDeps = ExpireAbandonedUploadDeps &
  ProcessPanoramaDeps &
  Omit<ProcessModelDeps, "media"> &
  MembershipInvitationMailDeps;

/** Kinds that can run for minutes: only the database's wake-up runs them, not the panel. */
export const LONG_JOB_KINDS: readonly string[] = ["media.process_panorama", "media.process_model"];

export function createProcessors(deps: ProcessorDeps): readonly JobProcessor[] {
  return [
    probeProcessor,
    createExpireAbandonedUploadProcessor(deps),
    createProcessPanoramaProcessor(deps),
    createProcessModelProcessor(deps),
    createMembershipInvitationMailProcessor(deps),
  ];
}
