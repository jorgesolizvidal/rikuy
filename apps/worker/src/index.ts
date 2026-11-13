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
import {
  createExtractDocumentProcessor,
  type ExtractDocumentDeps,
} from "./processors/extract-document";
import {
  createIndexKnowledgeProcessor,
  type IndexKnowledgeDeps,
} from "./processors/index-knowledge";
import { createMonthlyReportProcessor, type MonthlyReportDeps } from "./processors/monthly-report";
import { createProcessModelProcessor, type ProcessModelDeps } from "./processors/process-model";
import {
  createProcessPanoramaProcessor,
  type ProcessPanoramaDeps,
} from "./processors/process-panorama";
import { probeProcessor } from "./processors/probe";
import {
  createProbePortalProcessor,
  createTimedFetch,
  type ProbePortalDeps,
} from "./processors/probe-portal";
import {
  createRemoveUnusedMediaProcessor,
  type RemoveUnusedMediaDeps,
} from "./processors/remove-unused-media";

export {
  createExpireAbandonedUploadProcessor,
  createExtractDocumentProcessor,
  createIndexKnowledgeProcessor,
  createMembershipInvitationMailProcessor,
  createMonthlyReportProcessor,
  createProcessModelProcessor,
  createProcessPanoramaProcessor,
  createProbePortalProcessor,
  createRemoveUnusedMediaProcessor,
  createTimedFetch,
  probeProcessor,
};
export type {
  ExpireAbandonedUploadDeps,
  ExtractDocumentDeps,
  IndexKnowledgeDeps,
  MembershipInvitationMailDeps,
  MonthlyReportDeps,
  ProcessModelDeps,
  ProcessPanoramaDeps,
  ProbePortalDeps,
  RemoveUnusedMediaDeps,
};

/** What the processors need from the platform (adapters built by the runtime). */
export type ProcessorDeps = ExpireAbandonedUploadDeps &
  ProcessPanoramaDeps &
  Omit<ProcessModelDeps, "media"> &
  MembershipInvitationMailDeps &
  RemoveUnusedMediaDeps &
  ProbePortalDeps &
  MonthlyReportDeps &
  Omit<ExtractDocumentDeps, "media"> &
  Omit<IndexKnowledgeDeps, "media">;

/** Kinds that can run for minutes: only the database's wake-up runs them, not the panel. */
export const LONG_JOB_KINDS: readonly string[] = [
  "media.process_panorama",
  "media.process_model",
  "media.extract_document",
];

export function createProcessors(deps: ProcessorDeps): readonly JobProcessor[] {
  return [
    probeProcessor,
    createExpireAbandonedUploadProcessor(deps),
    createProcessPanoramaProcessor(deps),
    createProcessModelProcessor(deps),
    createMembershipInvitationMailProcessor(deps),
    createRemoveUnusedMediaProcessor(deps),
    createExtractDocumentProcessor(deps),
    createIndexKnowledgeProcessor(deps),
    createProbePortalProcessor(deps),
    createMonthlyReportProcessor(deps),
  ];
}
