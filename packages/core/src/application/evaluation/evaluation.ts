import { ASSISTANT_GOLD } from "../assistant/gold-set";
import {
  fillGoldText,
  goldSplit,
  gradeAssistantCase,
  type GoldCase,
  type GoldNames,
} from "../assistant/gold";
import type { AssistantResult } from "../assistant/ask";
import type { PlatformRepository, PlatformTenantSummary } from "../platform/ports";
import { COPILOT_GOLD } from "./copilot-gold";
import { datasetOf, itemsOf, pendingItems, type EvalItem } from "./plan";
import type { EvalKind, EvalRepository, EvalResultRow, EvalRunSummary, EvalSuite } from "./ports";
import { evaluationReport, type EvalReport } from "./report";

/**
 * «Evaluar el asistente» and «Evaluar el Copilot» (ADR-045): an operator with a second
 * factor starts a run against two demos, runs it in batches spaced for the provider's
 * tokens per minute, rates the held-out answers and reads the report. Everything is kept by
 * the database; nothing here publishes anything.
 */

export const ASSISTANT_BATCH = 5;
export const ASSISTANT_SPACING_MS = 15_000;

type Platform = Pick<PlatformRepository, "operatorAccess" | "listTenants">;

export interface EvalTenants {
  readonly a: PlatformTenantSummary;
  readonly b: PlatformTenantSummary | null;
}

function usableDemo(tenant: PlatformTenantSummary | undefined): tenant is PlatformTenantSummary {
  return (
    tenant !== undefined &&
    tenant.demo &&
    tenant.status === "active" &&
    tenant.canonicalHost !== null
  );
}

export type StartEvaluationResult =
  | { readonly status: "started"; readonly runId: string }
  | { readonly status: "forbidden" | "invalid" | "not_ready" | "not_configured" };

export async function startEvaluation(
  input: { readonly suite: unknown; readonly tenantA: unknown; readonly tenantB: unknown },
  deps: {
    readonly platform: Platform;
    readonly evals: EvalRepository;
    /** The gateway's provider and model; null when the AI is not configured. */
    readonly model: { readonly provider: string; readonly model: string } | null;
  },
): Promise<StartEvaluationResult> {
  if ((await deps.platform.operatorAccess()) !== "ok") return { status: "forbidden" };
  if (deps.model === null) return { status: "not_configured" };
  const suite = input.suite === "assistant" || input.suite === "copilot" ? input.suite : null;
  const b = typeof input.tenantB === "string" && input.tenantB !== "" ? input.tenantB : null;
  if (suite === null || typeof input.tenantA !== "string" || b === input.tenantA) {
    return { status: "invalid" };
  }
  const tenants = await deps.platform.listTenants();
  if (!usableDemo(tenants.find((tenant) => tenant.tenantId === input.tenantA))) {
    return { status: "not_ready" };
  }
  if (b !== null && !usableDemo(tenants.find((tenant) => tenant.tenantId === b))) {
    return { status: "not_ready" };
  }
  const started = await deps.evals.start({
    suite,
    dataset: datasetOf(suite),
    tenantA: input.tenantA,
    tenantB: b,
    provider: deps.model.provider,
    model: deps.model.model,
  });
  return started.status === "started" ? started : { status: "invalid" };
}

export interface EvaluationView {
  readonly runs: readonly EvalRunSummary[];
  readonly run: EvalRunSummary | null;
  readonly rows: readonly EvalResultRow[];
  readonly report: EvalReport | null;
  /** Items still to run (not evaluated yet, or that got a notice). */
  readonly pending: number;
  /** The run's dataset is not this build's (a case changed): it cannot continue. */
  readonly outdated: boolean;
}

export async function loadEvaluation(
  suite: EvalSuite,
  runId: string | null,
  deps: { readonly platform: Platform; readonly evals: EvalRepository },
): Promise<EvaluationView | null> {
  if ((await deps.platform.operatorAccess()) !== "ok") return null;
  const runs = await deps.evals.runs(suite);
  const run = (runId ? runs.find((entry) => entry.id === runId) : runs[0]) ?? null;
  if (run === null) {
    return { runs, run: null, rows: [], report: null, pending: 0, outdated: false };
  }
  const rows = (await deps.evals.results(run.id)) ?? [];
  return {
    runs,
    run,
    rows,
    report: evaluationReport(suite, rows),
    pending: pendingItems(itemsOf(suite), rows).length,
    outdated: run.dataset !== datasetOf(suite),
  };
}

export async function rateEvaluationAnswer(
  input: {
    readonly runId: unknown;
    readonly caseId: unknown;
    readonly repetition: unknown;
    readonly rating: unknown;
  },
  deps: { readonly platform: Platform; readonly evals: EvalRepository },
): Promise<"rated" | "forbidden" | "invalid" | "not_found"> {
  if ((await deps.platform.operatorAccess()) !== "ok") return "forbidden";
  const repetition = Number(input.repetition);
  const rating = input.rating === null || input.rating === "" ? null : Number(input.rating);
  if (
    typeof input.runId !== "string" ||
    typeof input.caseId !== "string" ||
    !Number.isInteger(repetition) ||
    (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5))
  ) {
    return "invalid";
  }
  return deps.evals.rate(input.runId, input.caseId, repetition, rating);
}

export async function finishEvaluation(
  runId: unknown,
  deps: { readonly platform: Platform; readonly evals: EvalRepository },
): Promise<"finished" | "forbidden" | "not_found"> {
  if ((await deps.platform.operatorAccess()) !== "ok") return "forbidden";
  if (typeof runId !== "string") return "not_found";
  return deps.evals.finish(runId);
}

/** «Retirar los datos de prueba»: only in a demo (the database checks it too). */
export async function retireEvalFixtures(
  tenantId: unknown,
  deps: { readonly platform: Platform; readonly evals: EvalRepository },
): Promise<
  | { readonly status: "retired"; readonly items: number }
  | { readonly status: "forbidden" | "invalid" }
> {
  if ((await deps.platform.operatorAccess()) !== "ok") return { status: "forbidden" };
  if (typeof tenantId !== "string") return { status: "invalid" };
  const tenants = await deps.platform.listTenants();
  if (!tenants.some((tenant) => tenant.tenantId === tenantId && tenant.demo)) {
    return { status: "invalid" };
  }
  const items = await deps.evals.retireFixtures(tenantId);
  return items === null ? { status: "invalid" } : { status: "retired", items };
}

// ── The assistant ──────────────────────────────────────────────────────────

/** The sample tour's scenes on one portal (its published manifest). */
export interface SampleTourRefs {
  readonly entry: string;
  readonly second: string | null;
  /** The information point of the entry scene. */
  readonly info: string | null;
}

export interface BatchCase {
  readonly caseId: string;
  readonly repetition: number;
  readonly pass: boolean | null;
  readonly problems: readonly string[];
}

export type BatchResult =
  | { readonly status: "done"; readonly ran: readonly BatchCase[]; readonly remaining: number }
  /** waiting: the next cases need demo B or its trap data. */
  | {
      readonly status:
        "forbidden" | "not_found" | "finished" | "outdated" | "not_ready" | "waiting";
    };

export interface AssistantBatchDeps {
  readonly platform: Platform;
  readonly evals: EvalRepository;
  /** Asks the demo's assistant as a visitor of its portal would. */
  readonly ask: (canonicalHost: string, body: unknown) => Promise<AssistantResult>;
  readonly sampleTour: (canonicalHost: string) => Promise<SampleTourRefs | null>;
  /** The trap data is in place in demo B and the assistant read it. */
  readonly fixturesReady: (tenantId: string) => Promise<boolean>;
  readonly wait: (ms: number) => Promise<void>;
}

/** The case needs demo B: it is asked there, names it, or uses its tour or trap data. */
export function needsDemoB(gold: GoldCase): boolean {
  return (
    gold.tenant === "B" ||
    gold.fixtures === true ||
    gold.question.includes("{B}") ||
    (gold.checks?.forbidden ?? []).some((word) => word.includes("{B}")) ||
    (gold.tour !== undefined && "scene" in gold.tour && gold.tour.scene === "other")
  );
}

function kindOf(gold: GoldCase): EvalKind {
  if (gold.expect.kind === "plan") return "plan";
  if (gold.expect.kind === "guide") return "guide";
  return "chat";
}

function answerText(result: AssistantResult): string {
  const reply = result.reply;
  if (reply.status === "notice") return reply.notice.message;
  if (reply.status !== "answered") return "";
  const text = reply.blocks
    .map((block) => (block.type === "paragraph" ? block.text : block.items.join(" · ")))
    .join("\n");
  const plan = reply.plan
    ? `\n${reply.plan.stops.map((stop) => `${stop.position}. ${stop.title}${stop.distance ? ` (${stop.distance})` : ""}`).join("\n")}`
    : "";
  const sources = reply.sources.length
    ? `\n\nFuentes: ${reply.sources.map((source) => `${source.label}: ${source.title}`).join("; ")}`
    : "";
  return `${text}${plan}${sources}`;
}

function tourBody(
  gold: GoldCase,
  own: SampleTourRefs | null,
  other: SampleTourRefs | null,
): { readonly sceneId: string; readonly hotspotId?: string } | undefined {
  const ref = gold.tour;
  if (ref === undefined) return undefined;
  if ("sceneId" in ref) return { sceneId: ref.sceneId };
  const tour = ref.scene === "other" ? other : own;
  const sceneId = ref.scene === "second" ? (tour?.second ?? null) : (tour?.entry ?? null);
  if (sceneId === null) return undefined;
  return ref.hotspot === "info" && tour?.info ? { sceneId, hotspotId: tour.info } : { sceneId };
}

async function runContext(
  runId: unknown,
  platform: Platform,
  evals: EvalRepository,
  suite: EvalSuite,
) {
  if ((await platform.operatorAccess()) !== "ok") return { status: "forbidden" as const };
  if (typeof runId !== "string") return { status: "not_found" as const };
  const run = (await evals.runs(suite)).find((entry) => entry.id === runId);
  if (!run) return { status: "not_found" as const };
  if (run.finishedAt !== null) return { status: "finished" as const };
  if (run.dataset !== datasetOf(suite)) return { status: "outdated" as const };
  const tenants = await platform.listTenants();
  const a = tenants.find((tenant) => tenant.tenantId === run.tenantA.id);
  const b = run.tenantB ? tenants.find((tenant) => tenant.tenantId === run.tenantB?.id) : undefined;
  if (!usableDemo(a) || (run.tenantB !== null && !usableDemo(b))) {
    return { status: "not_ready" as const };
  }
  const rows = (await evals.results(run.id)) ?? [];
  const names: GoldNames = { A: a.displayName, B: b?.displayName ?? null };
  return { status: "ok" as const, run, a, b: usableDemo(b) ? b : null, rows, names };
}

export async function runAssistantBatch(
  input: { readonly runId: unknown },
  deps: AssistantBatchDeps,
): Promise<BatchResult> {
  const context = await runContext(input.runId, deps.platform, deps.evals, "assistant");
  if (context.status !== "ok") return { status: context.status };
  const { run, a, b, rows, names } = context;
  const byId = new Map(ASSISTANT_GOLD.map((gold) => [gold.id, gold]));
  const ready = b === null ? false : await deps.fixturesReady(b.tenantId);
  const blocked = (item: EvalItem) => {
    const gold = byId.get(item.caseId);
    if (!gold) return true;
    if (needsDemoB(gold) && b === null) return true;
    return gold.fixtures === true && !ready;
  };
  const pending = pendingItems(itemsOf("assistant"), rows, blocked);
  if (pending.length === 0) {
    const all = pendingItems(itemsOf("assistant"), rows);
    return all.length === 0 ? { status: "done", ran: [], remaining: 0 } : { status: "waiting" };
  }
  const [ownTour, otherTour] = await Promise.all([
    deps.sampleTour(a.canonicalHost as string),
    b ? deps.sampleTour(b.canonicalHost as string) : Promise.resolve(null),
  ]);

  const ran: BatchCase[] = [];
  for (const [index, item] of pending.slice(0, ASSISTANT_BATCH).entries()) {
    if (index > 0) await deps.wait(ASSISTANT_SPACING_MS);
    const gold = byId.get(item.caseId) as GoldCase;
    const onB = gold.tenant === "B" && b !== null;
    const tour = tourBody(gold, onB ? otherTour : ownTour, onB ? ownTour : otherTour);
    const result = await deps.ask((onB ? b : a).canonicalHost as string, {
      question: fillGoldText(gold.question, names),
      history: gold.history ?? [],
      page: gold.page ?? { kind: "home" },
      ...(gold.distances ? { distances: gold.distances } : {}),
      ...(gold.intent ? { intent: gold.intent } : {}),
      ...(tour ? { tour } : {}),
    });
    const grade = gradeAssistantCase(gold, result, names);
    await deps.evals.record(run.id, item.caseId, item.repetition, {
      split: goldSplit(gold.id),
      category: gold.category,
      kind: kindOf(gold),
      pass: grade.pass,
      problems: grade.problems,
      answer: answerText(result).slice(0, 4000),
      cited: (result.trace?.plan?.stops ?? result.trace?.cited ?? []).slice(0, 20),
      retrieved: (result.trace?.retrieved ?? []).slice(0, 20),
      inputTokens: result.trace?.inputTokens ?? 0,
      outputTokens: result.trace?.outputTokens ?? 0,
      latencyMs: result.trace?.latencyMs ?? 0,
      metrics: { ...grade.metrics },
    });
    ran.push({
      caseId: item.caseId,
      repetition: item.repetition,
      pass: grade.pass,
      problems: grade.problems,
    });
  }
  return { status: "done", ran, remaining: pending.length - ran.length };
}

/** The ids of every case, by suite (for the page's table). */
export function evaluationCases(
  suite: EvalSuite,
): ReadonlyMap<string, { readonly question: string; readonly category: string }> {
  return suite === "assistant"
    ? new Map(
        ASSISTANT_GOLD.map((gold) => [
          gold.id,
          { question: gold.question, category: gold.category },
        ]),
      )
    : new Map(
        COPILOT_GOLD.map((gold) => [
          gold.id,
          {
            question:
              gold.action.type === "ask"
                ? gold.action.question
                : `Proponer ${gold.action.fields.join(", ")} (${gold.action.target.kind === "scene" ? "escena de entrada" : gold.action.target.slug})${gold.action.words ? `: ${gold.action.words}` : ""}`,
            category: gold.category,
          },
        ]),
      );
}
