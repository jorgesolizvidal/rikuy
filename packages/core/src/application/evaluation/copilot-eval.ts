import type { CopilotAnswer, ProposalTarget, ProposalView } from "../../contracts/copilot";
import type { OrganizationMembership } from "../../contracts/organization";
import { fillGoldText } from "../assistant/gold";
import type { CopilotTrace, ProposeOutcome } from "../copilot/copilot";
import {
  COPILOT_GOLD,
  gradeCopilotCase,
  type CopilotGoldCase,
  type CopilotGoldTarget,
  type CopilotRunOutcome,
} from "./copilot-gold";
import type { BatchCase, BatchResult } from "./evaluation";
import { datasetOf, itemsOf, pendingItems, type EvalItem } from "./plan";
import type { EvalRepository } from "./ports";
import type { PlatformRepository } from "../platform/ports";

/**
 * «Evaluar el Copilot» (ADR-045): the operator, as owner or administrator of both demos,
 * asks and requests proposals like any staff member. Every proposal is read back and
 * rejected; nothing is accepted nor published. Before and after each case the demo's
 * content is compared: any change fails the case.
 */

export const COPILOT_BATCH = 2;
/** A proposal reads up to 12.000 tokens: spaced for the provider's 8.000 per minute. */
export const COPILOT_SPACING_MS = 45_000;

export interface CopilotBatchDeps {
  readonly platform: Pick<PlatformRepository, "operatorAccess" | "listTenants">;
  readonly evals: EvalRepository;
  /** The operator's own membership in that demo (owner or admin with a second factor). */
  readonly membership: (tenantId: string) => Promise<OrganizationMembership | null>;
  readonly ask: (
    membership: OrganizationMembership,
    question: string,
  ) => Promise<{ readonly answer: CopilotAnswer; readonly trace: CopilotTrace }>;
  readonly propose: (
    membership: OrganizationMembership,
    input: {
      readonly target: ProposalTarget;
      readonly fields: readonly string[];
      readonly style: string;
      readonly words: string;
    },
  ) => Promise<{ readonly outcome: ProposeOutcome; readonly trace: CopilotTrace }>;
  readonly proposal: (
    membership: OrganizationMembership,
    id: string,
  ) => Promise<ProposalView | null>;
  readonly reject: (membership: OrganizationMembership, id: string) => Promise<unknown>;
  /** The content item with that address, or the sample tour's entry scene. */
  readonly target: (
    membership: OrganizationMembership,
    target: CopilotGoldTarget,
  ) => Promise<ProposalTarget | null>;
  /** What visitors and editors see of the demo's content now (published and drafts). */
  readonly state: (membership: OrganizationMembership) => Promise<string>;
  readonly fixturesReady: (tenantId: string) => Promise<boolean>;
  readonly wait: (ms: number) => Promise<void>;
}

const ROLES = new Set(["owner", "admin"]);

export async function runCopilotBatch(
  input: { readonly runId: unknown },
  deps: CopilotBatchDeps,
): Promise<BatchResult> {
  if ((await deps.platform.operatorAccess()) !== "ok") return { status: "forbidden" };
  if (typeof input.runId !== "string") return { status: "not_found" };
  const run = (await deps.evals.runs("copilot")).find((entry) => entry.id === input.runId);
  if (!run) return { status: "not_found" };
  if (run.finishedAt !== null) return { status: "finished" };
  if (run.dataset !== datasetOf("copilot")) return { status: "outdated" };

  const [a, b] = await Promise.all([
    deps.membership(run.tenantA.id),
    run.tenantB ? deps.membership(run.tenantB.id) : Promise.resolve(null),
  ]);
  if (
    a === null ||
    !ROLES.has(a.role) ||
    (run.tenantB !== null && (b === null || !ROLES.has(b.role)))
  ) {
    return { status: "not_ready" };
  }
  const names = { A: run.tenantA.displayName, B: run.tenantB?.displayName ?? null };
  const rows = (await deps.evals.results(run.id)) ?? [];
  const byId = new Map(COPILOT_GOLD.map((gold) => [gold.id, gold]));
  const ready = b === null ? false : await deps.fixturesReady(b.tenantId);
  const blocked = (item: EvalItem) => {
    const gold = byId.get(item.caseId);
    if (!gold) return true;
    const needsB =
      gold.tenant === "B" || gold.fixtures === true || JSON.stringify(gold.action).includes("{B}");
    if (needsB && b === null) return true;
    return gold.fixtures === true && !ready;
  };
  const pending = pendingItems(itemsOf("copilot"), rows, blocked);
  if (pending.length === 0) {
    const all = pendingItems(itemsOf("copilot"), rows);
    return all.length === 0 ? { status: "done", ran: [], remaining: 0 } : { status: "waiting" };
  }

  const ran: BatchCase[] = [];
  for (const [index, item] of pending.slice(0, COPILOT_BATCH).entries()) {
    if (index > 0) await deps.wait(COPILOT_SPACING_MS);
    const gold = byId.get(item.caseId) as CopilotGoldCase;
    const membership = gold.tenant === "B" && b !== null ? b : a;
    const before = await deps.state(membership);
    let outcome: CopilotRunOutcome;
    let created: string | null = null;
    if (gold.action.type === "ask") {
      const asked = await deps.ask(membership, fillGoldText(gold.action.question, names));
      outcome = { type: "ask", ...asked };
    } else {
      const target = await deps.target(membership, gold.action.target);
      if (target === null) {
        outcome = {
          type: "propose",
          outcome: { status: "not_found" },
          proposal: null,
          trace: { inputTokens: 0, outputTokens: 0, latencyMs: 0, invented: 0 },
        };
      } else {
        const proposed = await deps.propose(membership, {
          target,
          fields: gold.action.fields,
          style: gold.action.style,
          words: fillGoldText(gold.action.words ?? "", names),
        });
        created = proposed.outcome.status === "created" ? proposed.outcome.proposalId : null;
        const proposal = created ? await deps.proposal(membership, created) : null;
        outcome = { type: "propose", outcome: proposed.outcome, proposal, trace: proposed.trace };
      }
    }
    const after = await deps.state(membership);
    const grade = gradeCopilotCase(gold, outcome, {
      orgSlug: membership.slug,
      actionTaken: before !== after,
      names,
    });
    // The evaluation never leaves a proposal behind.
    if (created) await deps.reject(membership, created);
    await deps.evals.record(run.id, item.caseId, item.repetition, {
      split: "copilot",
      category: gold.category,
      kind: gold.action.type === "ask" ? "copilot_ask" : "copilot_propose",
      pass: grade.pass,
      problems: grade.problems,
      answer: grade.answer.slice(0, 4000),
      cited: [],
      retrieved: [],
      inputTokens: outcome.trace.inputTokens,
      outputTokens: outcome.trace.outputTokens,
      latencyMs: outcome.trace.latencyMs,
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
