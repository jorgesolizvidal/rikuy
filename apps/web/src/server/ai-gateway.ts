import "server-only";

import { EnvValidationError, parseAiEnv, type AiEnv } from "@rikuy/config/env";
import {
  createSimulatedAiProvider,
  runAiRequest,
  runAiSession,
  type AiCall,
  type AiLogger,
  type AiProvider,
  type AiRequestInput,
  type AiResult,
  type AiSessionInput,
  type AiSessionResult,
  type KnowledgePassage,
  type TourGuideContext,
} from "@rikuy/core";
import { createGroqProvider, createPostgresAiLedger, type PostgresAiLedger } from "@rikuy/db/ai";

/**
 * The AI gateway (ADR-036). The only module that opens the AI workload's database
 * connection (role rikuy_ai) and holds the provider key: ESLint forbids both anywhere else.
 * Every request — the visitor's assistant (P5 · Paso 3), the staff's (Paso 7) and the
 * operator's «Probar la IA» — goes through runAi.
 *
 * Without its settings there is no AI and nothing else changes: the result says so and the
 * portal shows its notice.
 */

/** One structured line per event (Vercel logs). Never questions, answers or keys. */
const jsonAiLogger: AiLogger = {
  event(name, fields) {
    const level =
      name === "ai.begin_failed" || name === "ai.finish_failed" || name === "ai.setup_failed"
        ? "warn"
        : "info";
    console.log(JSON.stringify({ level, event: name, ...fields, at: new Date().toISOString() }));
  },
};

type Settings =
  | { readonly env: AiEnv; readonly invalidKeys: null }
  | { readonly env: null; readonly invalidKeys: readonly string[] | null };

function settings(): Settings {
  try {
    const env = parseAiEnv();
    return env === null ? { env: null, invalidKeys: null } : { env, invalidKeys: null };
  } catch (error) {
    // A half-made configuration is a mistake to fix, not a reason to break pages: the
    // operator sees which variable is wrong and the log says the same (names, never values).
    if (error instanceof EnvValidationError) {
      console.log(
        JSON.stringify({ level: "warn", event: "ai.misconfigured", keys: error.invalidKeys }),
      );
      return { env: null, invalidKeys: error.invalidKeys };
    }
    throw error;
  }
}

export interface AiGatewayStatus {
  readonly configured: boolean;
  /** Variables set but unusable (names only), so the operator knows what to fix. */
  readonly invalidKeys: readonly string[];
  readonly provider: string | null;
  readonly model: string | null;
}

export function aiGatewayStatus(): AiGatewayStatus {
  const { env, invalidKeys } = settings();
  if (env === null)
    return { configured: false, invalidKeys: invalidKeys ?? [], provider: null, model: null };
  return {
    configured: true,
    invalidKeys: [],
    provider: env.AI_PROVIDER,
    model: env.AI_PROVIDER === "simulated" ? createSimulatedAiProvider().model : env.AI_MODEL,
  };
}

// Kept across requests of a warm function: one small pool, reconnected by postgres.js.
let ledger: PostgresAiLedger | null = null;
let ledgerUrl: string | null = null;

function ledgerFor(env: AiEnv): PostgresAiLedger {
  if (ledger === null || ledgerUrl !== env.AI_DATABASE_URL) {
    ledger = createPostgresAiLedger({
      url: env.AI_DATABASE_URL,
      maxConnections: 2,
      ...(env.AI_DATABASE_ROLE ? { role: env.AI_DATABASE_ROLE } : {}),
    });
    ledgerUrl = env.AI_DATABASE_URL;
  }
  return ledger;
}

function providerFor(env: AiEnv): AiProvider | null {
  if (env.AI_PROVIDER === "simulated") return createSimulatedAiProvider();
  return env.GROQ_API_KEY
    ? createGroqProvider({ apiKey: env.GROQ_API_KEY, model: env.AI_MODEL })
    : null;
}

function depsFor(env: AiEnv): { ledger: PostgresAiLedger; provider: AiProvider | null } | null {
  try {
    return { ledger: ledgerFor(env), provider: providerFor(env) };
  } catch (error) {
    // Whatever the configuration, the AI never breaks the page that asked: no AI this time.
    jsonAiLogger.event("ai.setup_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    ledger = null;
    ledgerUrl = null;
    return null;
  }
}

export async function runAi(input: AiRequestInput): Promise<AiResult> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return { outcome: "not_configured", requestId: null };
  return runAiRequest(input, { ...deps, logger: jsonAiLogger });
}

/** A request that may call the model more than once (the visitor's assistant, ADR-038). */
export async function runAiWork<T>(
  input: AiSessionInput,
  work: (call: AiCall) => Promise<T>,
): Promise<AiSessionResult<T>> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return { outcome: "not_configured", requestId: null };
  return runAiSession(input, { ...deps, logger: jsonAiLogger }, work);
}

/** What the assistant may read now (ai_api.search_knowledge through the AI role). */
export async function searchAiKnowledge(
  tenantId: string,
  query: string,
  limit: number,
): Promise<KnowledgePassage[]> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return [];
  return deps.ledger.searchKnowledge(tenantId, query, limit);
}

/** ai_api.tour_context (ADR-040): the tour's scene and point, checked against what is published. */
export async function aiTourContext(
  tenantId: string,
  item: { readonly kind: "destination" | "event"; readonly slug: string },
  sceneId: string | null,
  hotspotId: string | null,
): Promise<TourGuideContext | null> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return null;
  return deps.ledger.tourContext(tenantId, item, sceneId, hotspotId);
}
