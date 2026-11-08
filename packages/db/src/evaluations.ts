import type { EvalRepository, EvalResultRow, EvalRunSummary, EvalSuite } from "@rikuy/core";
import { z } from "zod";

import { failure, unexpected } from "./content";
import type { SessionClient } from "./session-client";

/**
 * The operator's evaluation runs (ADR-045), with the operator's own session: every RPC
 * checks the second factor again; the tables are never read directly.
 */

const tenantSchema = z.object({ id: z.uuid(), slug: z.string(), displayName: z.string() });

const runSchema = z.object({
  id: z.uuid(),
  suite: z.enum(["assistant", "copilot"]),
  dataset: z.string(),
  tenantA: tenantSchema,
  tenantB: tenantSchema.nullable(),
  provider: z.string(),
  model: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  results: z.number().int(),
});

const resultSchema = z.object({
  caseId: z.string(),
  repetition: z.number().int(),
  split: z.enum(["dev", "heldout", "security", "copilot"]),
  category: z.string(),
  kind: z.enum(["chat", "guide", "plan", "copilot_ask", "copilot_propose"]),
  pass: z.boolean().nullable(),
  problems: z.array(z.string()),
  answer: z.string(),
  cited: z.array(z.string()),
  retrieved: z.array(z.string()),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  latencyMs: z.number().int(),
  metrics: z.record(z.string(), z.union([z.number(), z.boolean()])).catch({}),
  priceVersion: z.string().nullable(),
  estimatedCostUsd: z.coerce.number().nullable(),
  rating: z.number().int().nullable(),
  recordedAt: z.string(),
});

export function createEvalRepository(client: SessionClient): EvalRepository {
  return {
    async start(input) {
      const { data, error, status } = await client.rpc("platform_eval_start", {
        p_suite: input.suite,
        p_dataset: input.dataset,
        p_tenant_a: input.tenantA,
        p_tenant_b: input.tenantB,
        p_provider: input.provider,
        p_model: input.model,
      });
      if (error) {
        if (failure(error, status) === "invalid") return { status: "invalid" };
        throw unexpected("Starting an evaluation", error);
      }
      return { status: "started", runId: z.uuid().parse(data) };
    },

    async runs(suite: EvalSuite): Promise<EvalRunSummary[]> {
      const { data, error } = await client.rpc("platform_eval_runs", { p_suite: suite });
      if (error) throw unexpected("Reading evaluation runs", error);
      return z.array(runSchema).parse(data);
    },

    async results(runId): Promise<EvalResultRow[] | null> {
      const { data, error } = await client.rpc("platform_eval_results", { p_run_id: runId });
      if (error) throw unexpected("Reading evaluation results", error);
      return data === null ? null : z.array(resultSchema).parse(data);
    },

    async record(runId, caseId, repetition, result) {
      const { error, status } = await client.rpc("platform_eval_record", {
        p_run_id: runId,
        p_case_id: caseId,
        p_repetition: repetition,
        p_result: result,
      });
      if (!error) return "recorded";
      const kind = failure(error, status);
      if (kind === "not_found") return "not_found";
      if (kind === "conflict") return "finished";
      throw unexpected("Recording an evaluation result", error);
    },

    async rate(runId, caseId, repetition, rating) {
      const { error, status } = await client.rpc("platform_eval_rate", {
        p_run_id: runId,
        p_case_id: caseId,
        p_repetition: repetition,
        p_rating: rating,
      });
      if (!error) return "rated";
      const kind = failure(error, status);
      if (kind === "not_found") return "not_found";
      if (kind === "invalid") return "invalid";
      throw unexpected("Rating an evaluation answer", error);
    },

    async finish(runId) {
      const { error, status } = await client.rpc("platform_eval_finish", { p_run_id: runId });
      if (!error) return "finished";
      if (failure(error, status) === "not_found") return "not_found";
      throw unexpected("Finishing an evaluation", error);
    },

    async retireFixtures(tenantId) {
      const { data, error, status } = await client.rpc("platform_eval_retire_fixtures", {
        p_tenant_id: tenantId,
      });
      if (error) {
        if (failure(error, status) === "invalid") return null;
        throw unexpected("Retiring the trap data", error);
      }
      return z.number().int().parse(data);
    },
  };
}
