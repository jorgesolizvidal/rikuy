import type {
  EvalRepository,
  EvalResultInput,
  EvalResultRow,
  EvalRunSummary,
  EvalSuite,
} from "./ports";

/**
 * An in-memory EvalRepository for tests: no prices (estimated cost null), no audit. The
 * real one is the database's (platform_eval_*).
 */
export function createMemoryEvalRepository(): EvalRepository & {
  readonly retired: string[];
} {
  const runs = new Map<string, EvalRunSummary>();
  const results = new Map<string, Map<string, EvalResultRow>>();
  const retired: string[] = [];
  let next = 0;
  const tenant = (id: string) => ({ id, slug: id.slice(0, 8), displayName: id });
  return {
    retired,
    async start(input) {
      next += 1;
      const id = `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
      runs.set(id, {
        id,
        suite: input.suite,
        dataset: input.dataset,
        tenantA: tenant(input.tenantA),
        tenantB: input.tenantB ? tenant(input.tenantB) : null,
        provider: input.provider,
        model: input.model,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        results: 0,
      });
      results.set(id, new Map());
      return { status: "started", runId: id };
    },
    async runs(suite: EvalSuite) {
      return [...runs.values()]
        .filter((run) => run.suite === suite)
        .map((run) => ({ ...run, results: results.get(run.id)?.size ?? 0 }))
        .reverse();
    },
    async results(runId) {
      const rows = results.get(runId);
      return rows ? [...rows.values()] : null;
    },
    async record(runId, caseId, repetition, result: EvalResultInput) {
      const run = runs.get(runId);
      if (!run) return "not_found";
      if (run.finishedAt !== null) return "finished";
      results.get(runId)?.set(`${caseId}#${repetition}`, {
        ...result,
        caseId,
        repetition,
        priceVersion: null,
        estimatedCostUsd: null,
        rating: null,
        recordedAt: new Date().toISOString(),
      });
      return "recorded";
    },
    async rate(runId, caseId, repetition, rating) {
      const row = results.get(runId)?.get(`${caseId}#${repetition}`);
      if (!row || row.pass === null) return "not_found";
      results.get(runId)?.set(`${caseId}#${repetition}`, { ...row, rating });
      return "rated";
    },
    async finish(runId) {
      const run = runs.get(runId);
      if (!run || run.finishedAt !== null) return "not_found";
      runs.set(runId, { ...run, finishedAt: new Date().toISOString() });
      return "finished";
    },
    async retireFixtures(tenantId) {
      retired.push(tenantId);
      return 0;
    },
  };
}
