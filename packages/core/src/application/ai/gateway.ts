import {
  AI_PROFILE_SETTINGS,
  type AiMessage,
  type AiProfile,
  type AiRefusal,
  type AiResult,
} from "../../contracts/ai";

/**
 * The AI gateway (ADR-036). Every call to a model goes through runAiRequest:
 *
 *   1. reserve the request's tokens (municipality's day, platform's day, visitor's hour);
 *   2. only then call the provider, retrying once when it is down or slow;
 *   3. settle the reservation with what the calls really used.
 *
 * A refusal or a failure is a result, never an exception: the caller shows a notice and
 * the portal keeps working. Nothing reaches the provider without being accounted for.
 */

/** One call to the provider, as recorded in ai_executions. */
export interface AiExecution {
  readonly provider: string;
  readonly model: string;
  readonly status: "ok" | "rate_limited" | "timeout" | "unavailable" | "error";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
}

export type AiBeginOutcome =
  | "reserved"
  | Extract<AiRefusal, "tenant_quota" | "platform_quota" | "visitor_limit" | "tenant_unavailable">;

export type AiFinishOutcome = "answered" | "provider_unavailable" | "provider_error";

/** ai_api.begin_request / finish_request, through the AI workload's own role. */
export interface AiLedger {
  begin(input: {
    readonly tenantId: string;
    readonly profile: AiProfile;
    readonly reserveTokens: number;
    /** An opaque key of the visitor (the database keeps only a daily-salted hash). */
    readonly visitor: string | null;
    readonly actorId: string | null;
  }): Promise<{ readonly requestId: string; readonly outcome: AiBeginOutcome }>;
  finish(
    requestId: string,
    outcome: AiFinishOutcome,
    executions: readonly AiExecution[],
  ): Promise<void>;
}

export interface AiCompletion {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
}

export interface AiProvider {
  /** For the records: [a-z0-9_-]. */
  readonly name: string;
  readonly model: string;
  complete(
    request: {
      readonly messages: readonly AiMessage[];
      readonly maxOutputTokens: number;
      readonly temperature: number;
    },
    signal: AbortSignal,
  ): Promise<AiCompletion>;
}

/** How a provider call failed: what decides whether to retry and what the visitor sees. */
export class AiProviderError extends Error {
  constructor(
    readonly kind: "rate_limited" | "timeout" | "unavailable" | "error",
    readonly httpStatus: number | null = null,
    message = `AI provider: ${kind}`,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export interface AiLogger {
  event(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void;
}

/** Only the error's kind goes to the logs: never a message that could carry data. */
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/** Rough on purpose (characters / 3, plus a little per message): it over-reserves. */
export function estimateTokens(messages: readonly AiMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 3) + 4, 3);
}

/** What a request sets aside: its estimated input plus the most its profile may answer. */
export function reservationFor(profile: AiProfile, messages: readonly AiMessage[]): number {
  return estimateTokens(messages) + AI_PROFILE_SETTINGS[profile].maxOutputTokens;
}

export interface AiRequestInput {
  readonly tenantId: string;
  readonly profile: AiProfile;
  readonly messages: readonly AiMessage[];
  readonly visitor?: string | null;
  readonly actorId?: string | null;
}

export interface AiGatewayDeps {
  /** Null on a deployment without the gateway's connection. */
  readonly ledger: AiLedger | null;
  /** Null on a deployment without a provider key. */
  readonly provider: AiProvider | null;
  readonly now?: () => number;
  readonly logger?: AiLogger;
}

/** Retried: the provider may answer on a second try. Not a 429: retrying makes it worse. */
const RETRYABLE = new Set<AiExecution["status"]>(["timeout", "unavailable"]);
const MAX_ATTEMPTS = 2;

function failureOf(error: unknown): { status: AiExecution["status"]; httpStatus: number | null } {
  if (error instanceof AiProviderError) return { status: error.kind, httpStatus: error.httpStatus };
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError")
    return { status: "timeout", httpStatus: null };
  // A network failure (fetch throws a TypeError) or anything unexpected: worth one retry.
  return { status: "unavailable", httpStatus: null };
}

export async function runAiRequest(input: AiRequestInput, deps: AiGatewayDeps): Promise<AiResult> {
  const settings = AI_PROFILE_SETTINGS[input.profile];
  if (input.messages.length === 0) throw new RangeError("an AI request needs messages");
  const estimate = estimateTokens(input.messages);
  if (estimate > settings.maxInputTokens) {
    throw new RangeError(`AI request too large for ${input.profile}: ~${estimate} tokens`);
  }
  if (deps.ledger === null || deps.provider === null) {
    return { outcome: "not_configured", requestId: null };
  }
  const now = deps.now ?? Date.now;
  const provider = deps.provider;

  let begun: Awaited<ReturnType<AiLedger["begin"]>>;
  try {
    begun = await deps.ledger.begin({
      tenantId: input.tenantId,
      profile: input.profile,
      reserveTokens: estimate + settings.maxOutputTokens,
      visitor: input.visitor ?? null,
      actorId: input.actorId ?? null,
    });
  } catch (error) {
    // Without the ledger nothing can be accounted for: no call to the provider.
    deps.logger?.event("ai.begin_failed", { profile: input.profile, error: errorName(error) });
    return { outcome: "not_configured", requestId: null };
  }
  if (begun.outcome !== "reserved") {
    deps.logger?.event("ai.refused", { profile: input.profile, outcome: begun.outcome });
    return { outcome: begun.outcome, requestId: begun.requestId };
  }

  const executions: AiExecution[] = [];
  let answer: { text: string; inputTokens: number; outputTokens: number; model: string } | null =
    null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && answer === null; attempt += 1) {
    const started = now();
    try {
      const completion = await provider.complete(
        {
          messages: input.messages,
          maxOutputTokens: settings.maxOutputTokens,
          temperature: settings.temperature,
        },
        AbortSignal.timeout(settings.timeoutMs),
      );
      executions.push({
        provider: provider.name,
        model: completion.model,
        status: "ok",
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        latencyMs: Math.max(0, Math.round(now() - started)),
        httpStatus: 200,
      });
      answer = completion;
    } catch (error) {
      const failure = failureOf(error);
      executions.push({
        provider: provider.name,
        model: provider.model,
        status: failure.status,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Math.max(0, Math.round(now() - started)),
        httpStatus: failure.httpStatus,
      });
      if (!RETRYABLE.has(failure.status)) break;
    }
  }

  const last = executions.at(-1);
  const outcome: AiFinishOutcome =
    answer !== null
      ? "answered"
      : last?.status === "error"
        ? "provider_error"
        : "provider_unavailable";
  try {
    await deps.ledger.finish(begun.requestId, outcome, executions);
  } catch (error) {
    // The reservation expires on its own and counts as used (ADR-036): the answer stands.
    deps.logger?.event("ai.finish_failed", { profile: input.profile, error: errorName(error) });
  }
  deps.logger?.event("ai.finished", {
    profile: input.profile,
    outcome,
    attempts: executions.length,
    latencyMs: executions.reduce((sum, execution) => sum + execution.latencyMs, 0),
  });

  if (answer === null) {
    // Without an answer the outcome is never "answered"; the check only narrows the type.
    return {
      outcome: outcome === "answered" ? "provider_error" : outcome,
      requestId: begun.requestId,
    };
  }
  return {
    outcome: "answered",
    requestId: begun.requestId,
    text: answer.text,
    model: answer.model,
    usage: { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens },
    latencyMs: executions.reduce((sum, execution) => sum + execution.latencyMs, 0),
  };
}
