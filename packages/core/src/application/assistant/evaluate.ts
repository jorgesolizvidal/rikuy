import type { PlatformRepository } from "../platform/ports";
import type { AssistantResult } from "./ask";
import { ASSISTANT_GOLD, gradeAssistantCase, type GoldCategory } from "./gold";

/**
 * «Evaluar el asistente» (D7, ADR-038): the operator runs the gold against a demo with the
 * sample content, with the real model, a few cases at a time. Each case is graded on its
 * own; nothing is stored (the operator copies the results).
 */

/** Cases per run: spaced so a run stays under the provider's tokens per minute. */
export const GOLD_BATCH = 5;
export const GOLD_SPACING_MS = 15_000;

export interface GoldRunCase {
  readonly id: string;
  readonly category: GoldCategory;
  readonly question: string;
  /** null: not evaluated (a notice: quota or provider). */
  readonly pass: boolean | null;
  readonly problems: readonly string[];
  readonly answer: string;
  readonly cited: readonly string[];
  readonly retrieved: readonly string[];
  readonly planned: boolean;
  readonly tokens: number;
  readonly latencyMs: number;
}

export type GoldRunOutcome =
  | {
      readonly status: "done";
      readonly cases: readonly GoldRunCase[];
      readonly next: number | null;
    }
  | { readonly status: "forbidden" | "not_found" | "not_ready" | "invalid" };

export async function evaluateAssistantGold(
  input: { readonly tenantId: unknown; readonly from: unknown },
  deps: {
    readonly platform: Pick<PlatformRepository, "operatorAccess" | "listTenants">;
    /** Asks the tenant's assistant as a visitor of its portal would. */
    readonly ask: (canonicalHost: string, body: unknown) => Promise<AssistantResult>;
    readonly wait: (ms: number) => Promise<void>;
  },
): Promise<GoldRunOutcome> {
  if ((await deps.platform.operatorAccess()) !== "ok") return { status: "forbidden" };
  const from = typeof input.from === "number" ? input.from : Number(input.from);
  if (!Number.isInteger(from) || from < 1 || from > ASSISTANT_GOLD.length) {
    return { status: "invalid" };
  }
  const tenants = await deps.platform.listTenants();
  const tenant = tenants.find((entry) => entry.tenantId === input.tenantId);
  if (!tenant) return { status: "not_found" };
  // The gold asks about the sample content: a demo, online, with its portal address.
  if (!tenant.demo || tenant.status !== "active" || tenant.canonicalHost === null) {
    return { status: "not_ready" };
  }

  const batch = ASSISTANT_GOLD.slice(from - 1, from - 1 + GOLD_BATCH);
  const cases: GoldRunCase[] = [];
  for (const [index, gold] of batch.entries()) {
    if (index > 0) await deps.wait(GOLD_SPACING_MS);
    const result = await deps.ask(tenant.canonicalHost, {
      question: gold.question,
      history: gold.history ?? [],
      page: gold.page ?? { kind: "home" },
      ...(gold.distances ? { distances: gold.distances } : {}),
      ...(gold.intent ? { intent: gold.intent } : {}),
      ...(gold.tour ? { tour: gold.tour } : {}),
    });
    const grade = gradeAssistantCase(gold, result);
    const reply = result.reply;
    cases.push({
      id: gold.id,
      category: gold.category,
      question: gold.question,
      pass: grade.pass,
      problems: grade.problems,
      answer:
        reply.status === "answered"
          ? reply.blocks
              .map((block) => (block.type === "paragraph" ? block.text : block.items.join(" · ")))
              .join(" ")
          : reply.status === "notice"
            ? reply.notice.message
            : "",
      cited: result.trace?.plan?.stops ?? result.trace?.cited ?? [],
      retrieved: result.trace?.retrieved ?? [],
      planned: result.trace?.planned ?? false,
      tokens: (result.trace?.inputTokens ?? 0) + (result.trace?.outputTokens ?? 0),
      latencyMs: result.trace?.latencyMs ?? 0,
    });
  }
  const next = from - 1 + batch.length;
  return { status: "done", cases, next: next < ASSISTANT_GOLD.length ? next + 1 : null };
}
