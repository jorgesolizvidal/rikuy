import {
  AI_PROFILE_SETTINGS,
  type AiUsageCount,
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
/** ai_api.finish_request records at most 3 calls per request. */
export const MAX_AI_CALLS = 3;

function failureOf(error: unknown): { status: AiExecution["status"]; httpStatus: number | null } {
  if (error instanceof AiProviderError) return { status: error.kind, httpStatus: error.httpStatus };
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError")
    return { status: "timeout", httpStatus: null };
  // A network failure (fetch throws a TypeError) or anything unexpected: worth one retry.
  return { status: "unavailable", httpStatus: null };
}

/** One call of a session: its messages, and how much of the profile's answer it may use. */
export interface AiStep {
  readonly messages: readonly AiMessage[];
  /** At most the profile's maximum. */
  readonly maxOutputTokens?: number;
  /** Calls this step may make (a retry when the provider is down). Default 2. */
  readonly attempts?: 1 | 2;
}

/** A step got no answer: the work may go on without it (or let it end the request). */
export class AiStepFailed extends Error {
  constructor(readonly outcome: "provider_unavailable" | "provider_error") {
    super(`AI step failed: ${outcome}`);
    this.name = "AiStepFailed";
  }
}

export interface AiSessionInput {
  readonly tenantId: string;
  readonly profile: AiProfile;
  /** Every step's estimated input plus its most output: what the request sets aside. */
  readonly reserveTokens: number;
  readonly visitor?: string | null;
  readonly actorId?: string | null;
}

export type AiSessionResult<T> =
  | {
      readonly outcome: "answered";
      readonly requestId: string;
      readonly value: T;
      readonly model: string;
      readonly usage: AiUsageCount;
      readonly latencyMs: number;
    }
  | { readonly outcome: AiRefusal; readonly requestId: string | null };

export type AiCall = (step: AiStep) => Promise<AiCompletion>;

/**
 * One request of the gateway that may call the model more than once (ADR-038: rephrase,
 * then answer): one reservation, one count against the visitor's hourly limit, and one
 * settlement with every call it made. A step that fails throws AiStepFailed; the work may
 * catch it and go on. Without a single answered call, the request is not answered.
 */
export async function runAiSession<T>(
  input: AiSessionInput,
  deps: AiGatewayDeps,
  work: (call: AiCall) => Promise<T>,
): Promise<AiSessionResult<T>> {
  const settings = AI_PROFILE_SETTINGS[input.profile];
  if (!Number.isInteger(input.reserveTokens) || input.reserveTokens < 1) {
    throw new RangeError("an AI request reserves a positive whole number of tokens");
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
      reserveTokens: input.reserveTokens,
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
  let model: string | null = null;
  const call: AiCall = async (step) => {
    const estimate = estimateTokens(step.messages);
    if (step.messages.length === 0) throw new RangeError("an AI step needs messages");
    if (estimate > settings.maxInputTokens) {
      throw new RangeError(`AI step too large for ${input.profile}: ~${estimate} tokens`);
    }
    const maxOutputTokens = Math.min(
      step.maxOutputTokens ?? settings.maxOutputTokens,
      settings.maxOutputTokens,
    );
    const attempts = step.attempts ?? 2;
    let last: AiExecution["status"] = "unavailable";
    for (let attempt = 1; attempt <= attempts && executions.length < MAX_AI_CALLS; attempt += 1) {
      const started = now();
      try {
        const completion = await provider.complete(
          { messages: step.messages, maxOutputTokens, temperature: settings.temperature },
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
        model = completion.model;
        return completion;
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
        last = failure.status;
        if (!RETRYABLE.has(failure.status)) break;
      }
    }
    throw new AiStepFailed(last === "error" ? "provider_error" : "provider_unavailable");
  };

  let value: { readonly result: T } | null = null;
  let failed: AiStepFailed["outcome"] = "provider_unavailable";
  try {
    value = { result: await work(call) };
  } catch (error) {
    if (error instanceof AiStepFailed) failed = error.outcome;
    else if (error instanceof RangeError) throw error;
    else {
      // A mistake in the work, not in the provider: settle what was used and say no answer.
      deps.logger?.event("ai.work_failed", { profile: input.profile, error: errorName(error) });
      failed = "provider_error";
    }
  }
  const answered = value !== null && executions.some((execution) => execution.status === "ok");
  const outcome: AiFinishOutcome = answered ? "answered" : failed;
  try {
    await deps.ledger.finish(begun.requestId, outcome, executions);
  } catch (error) {
    // The reservation expires on its own and counts as used (ADR-036): the answer stands.
    deps.logger?.event("ai.finish_failed", { profile: input.profile, error: errorName(error) });
  }
  const latencyMs = executions.reduce((sum, execution) => sum + execution.latencyMs, 0);
  deps.logger?.event("ai.finished", {
    profile: input.profile,
    outcome,
    attempts: executions.length,
    latencyMs,
  });
  if (!answered || value === null || model === null) {
    return {
      outcome: outcome === "answered" ? "provider_error" : outcome,
      requestId: begun.requestId,
    };
  }
  const ok = executions.filter((execution) => execution.status === "ok");
  return {
    outcome: "answered",
    requestId: begun.requestId,
    value: value.result,
    model,
    usage: {
      inputTokens: ok.reduce((sum, execution) => sum + execution.inputTokens, 0),
      outputTokens: ok.reduce((sum, execution) => sum + execution.outputTokens, 0),
    },
    latencyMs,
  };
}

/** A request with one call (and its retry): «Probar la IA» and the simplest uses. */
export async function runAiRequest(input: AiRequestInput, deps: AiGatewayDeps): Promise<AiResult> {
  const settings = AI_PROFILE_SETTINGS[input.profile];
  if (input.messages.length === 0) throw new RangeError("an AI request needs messages");
  const estimate = estimateTokens(input.messages);
  if (estimate > settings.maxInputTokens) {
    throw new RangeError(`AI request too large for ${input.profile}: ~${estimate} tokens`);
  }
  const result = await runAiSession(
    {
      tenantId: input.tenantId,
      profile: input.profile,
      reserveTokens: estimate + settings.maxOutputTokens,
      visitor: input.visitor ?? null,
      actorId: input.actorId ?? null,
    },
    deps,
    async (call) => (await call({ messages: input.messages })).text,
  );
  if (result.outcome !== "answered") return result;
  return {
    outcome: "answered",
    requestId: result.requestId,
    text: result.value,
    model: result.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
}
