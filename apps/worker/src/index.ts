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
import { probeProcessor } from "./processors/probe";

export { createExpireAbandonedUploadProcessor, probeProcessor };
export type { ExpireAbandonedUploadDeps };

/** What the processors need from the platform (adapters built by the runtime). */
export type ProcessorDeps = ExpireAbandonedUploadDeps;

export function createProcessors(deps: ProcessorDeps): readonly JobProcessor[] {
  return [probeProcessor, createExpireAbandonedUploadProcessor(deps)];
}
