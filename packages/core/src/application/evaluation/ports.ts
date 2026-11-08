/**
 * The evaluation runs of the assistant and the Copilot (ADR-045), kept by the database for
 * the operator (eval_runs / eval_results). The answers are about sample content.
 */

export type EvalSuite = "assistant" | "copilot";
export type EvalSplit = "dev" | "heldout" | "security" | "copilot";
export type EvalKind = "chat" | "guide" | "plan" | "copilot_ask" | "copilot_propose";

/** Counters and flags the report adds up (GoldMetrics, CopilotMetrics). */
export type EvalMetrics = Readonly<Record<string, number | boolean>>;

export interface EvalTenantRef {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
}

export interface EvalRunSummary {
  readonly id: string;
  readonly suite: EvalSuite;
  readonly dataset: string;
  readonly tenantA: EvalTenantRef;
  readonly tenantB: EvalTenantRef | null;
  readonly provider: string;
  readonly model: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly results: number;
}

export interface EvalResultInput {
  readonly split: EvalSplit;
  readonly category: string;
  readonly kind: EvalKind;
  /** null: not evaluated (a quota or the provider): run it again later. */
  readonly pass: boolean | null;
  readonly problems: readonly string[];
  readonly answer: string;
  readonly cited: readonly string[];
  readonly retrieved: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly metrics: EvalMetrics;
}

export interface EvalResultRow extends EvalResultInput {
  readonly caseId: string;
  readonly repetition: number;
  readonly priceVersion: string | null;
  readonly estimatedCostUsd: number | null;
  /** The operator's 1–5 rating of the answer (clarity and cultural adequacy). */
  readonly rating: number | null;
  readonly recordedAt: string;
}

export interface EvalRepository {
  start(input: {
    readonly suite: EvalSuite;
    readonly dataset: string;
    readonly tenantA: string;
    readonly tenantB: string | null;
    readonly provider: string;
    readonly model: string;
  }): Promise<
    { readonly status: "started"; readonly runId: string } | { readonly status: "invalid" }
  >;
  runs(suite: EvalSuite): Promise<EvalRunSummary[]>;
  /** null: no such run. */
  results(runId: string): Promise<EvalResultRow[] | null>;
  record(
    runId: string,
    caseId: string,
    repetition: number,
    result: EvalResultInput,
  ): Promise<"recorded" | "finished" | "not_found">;
  rate(
    runId: string,
    caseId: string,
    repetition: number,
    rating: number | null,
  ): Promise<"rated" | "not_found" | "invalid">;
  finish(runId: string): Promise<"finished" | "not_found">;
  /** Takes back what «Preparar los datos de prueba» published in a demo; how many items. */
  retireFixtures(tenantId: string): Promise<number | null>;
}
