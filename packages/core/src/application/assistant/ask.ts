import { AI_PROFILE_SETTINGS } from "../../contracts/ai";
import type { KnowledgePassage, PublicCitation } from "../../contracts/knowledge";
import type { TenantPresentation } from "../../contracts/presentation";
import { parseAnswer, parsePlan, type AnswerBlock } from "../../domain/assistant/answer";
import { detectLanguage, type AssistantLanguage } from "../../domain/assistant/language";
import { ASSISTANT_LIMITS } from "../../domain/assistant/limits";
import { pageHasItem, type AssistantPage } from "../../domain/assistant/page";
import { assistantPersona } from "../../domain/assistant/persona";
import {
  answerMessages,
  PASSAGE_BLOCK_MAX,
  planMessages,
  type AnswerContext,
  type AssistantSite,
} from "../../domain/assistant/prompts";
import { parseAssistantRequest, type AssistantRequest } from "../../domain/assistant/request";
import type { PlanIntent } from "../../domain/plan/engine";
import { detectPlanIntent } from "../../domain/plan/intent";
import {
  AiStepFailed,
  estimateTokens,
  type AiCall,
  type AiSessionInput,
  type AiSessionResult,
} from "../ai/gateway";
import { aiNotice, portalSectionLinks, type AiNotice } from "../ai/notices";
import { publicCitation } from "../knowledge/search";
import { answerPlan, type AssistantPlaces, type AssistantPlan } from "./plan";

/**
 * The visitor's assistant (ADR-038): one question is one request of the gateway — rephrase
 * when needed, search what the municipality published, answer from it — and nothing the
 * model writes reaches the visitor without being checked.
 */

/** How many passages the search returns; the model reads the best ASSISTANT_LIMITS.passages. */
const SEARCH_RESULTS = 8;
const PLAN_OUTPUT = 300;
const ANSWER_OUTPUT = 800;

export interface AssistantTenant {
  readonly tenantId: string;
  readonly timezone: string;
  readonly presentation: TenantPresentation;
  /** The municipality has visible tours (the general tour is a section). */
  readonly hasTours: boolean;
}

export interface AssistantDeps {
  /** The gateway (server/ai-gateway.ts → runAiSession). */
  session<T>(
    input: AiSessionInput,
    work: (call: AiCall) => Promise<T>,
  ): Promise<AiSessionResult<T>>;
  /** ai_api.search_knowledge: published passages of this municipality, best first. */
  search(tenantId: string, query: string, limit: number): Promise<KnowledgePassage[]>;
  /** The published destination, event or tour the visitor is on; null if none. */
  page(tenantId: string, page: AssistantPage): Promise<AssistantPageItem | null>;
  /** Published destinations (with hours) and upcoming events, for plans (ADR-039). */
  places(tenantId: string): Promise<AssistantPlaces>;
  readonly now: () => Date;
}

export interface AssistantPageItem {
  /** In words, for the model: «Destino «Mirador del valle»». */
  readonly label: string;
  /** Its title, added to the search so «aquí» finds it. */
  readonly title: string;
}

export interface AssistantLink {
  readonly label: string;
  readonly href: string;
}

export type AssistantReply =
  | {
      readonly status: "answered";
      readonly lang: AssistantLanguage;
      readonly speaker: string;
      readonly blocks: readonly AnswerBlock[];
      /** The validated citations, as the visitor sees them. */
      readonly sources: readonly PublicCitation[];
      /** No published text backs it: «sin datos publicados», with the portal and its contact. */
      readonly abstained: boolean;
      readonly links: readonly AssistantLink[];
      readonly contact: { readonly phone?: string; readonly email?: string } | null;
      /** «Qué hay cerca», «plan para hoy», «ruta sugerida»: the stops, decided by the engine. */
      readonly plan?: AssistantPlan;
    }
  | { readonly status: "notice"; readonly lang: AssistantLanguage; readonly notice: AiNotice }
  | { readonly status: "invalid" };

/** What happened inside, for the evaluation (never sent to the visitor). */
export interface AssistantTrace {
  readonly lang: AssistantLanguage;
  readonly planned: boolean;
  readonly query: string;
  /** Sources the search returned to the model, as `kind:slug`. */
  readonly retrieved: readonly string[];
  /** Sources the answer cited and that were valid, as `kind:slug`. */
  readonly cited: readonly string[];
  readonly invalidCitations: number;
  readonly usedSite: boolean;
  readonly wellFormed: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  /** A plan's intent, outcome and stops (`kind:slug`), in order. */
  readonly plan?: { readonly intent: PlanIntent; readonly stops: readonly string[] };
}

export interface AssistantResult {
  readonly reply: AssistantReply;
  readonly trace: AssistantTrace | null;
}

function today(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("es", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function sourceKey(passage: KnowledgePassage): string {
  const kind = passage.source === "tour" ? `${passage.kind}_tour` : passage.kind;
  return `${kind}:${passage.slug}`;
}

function siteOf(tenant: AssistantTenant): AssistantSite {
  const { identity, contact } = tenant.presentation;
  return {
    name: identity.siteName,
    tagline: identity.tagline,
    address: contact.address ?? null,
    phone: contact.phone ?? null,
    email: contact.email ?? null,
    sections: portalSectionLinks("es", tenant.hasTours).map((link) => link.label),
  };
}

/** The most the answer step may read: everything known now, plus full passages. */
function answerReservation(context: AnswerContext): number {
  const base = estimateTokens(answerMessages(context, []));
  return base + ASSISTANT_LIMITS.passages * Math.ceil(PASSAGE_BLOCK_MAX / 3 + 4) + ANSWER_OUTPUT;
}

function bestPassages(passages: readonly KnowledgePassage[]): KnowledgePassage[] {
  return passages.slice(0, ASSISTANT_LIMITS.passages);
}

export async function askAssistant(
  tenant: AssistantTenant,
  raw: unknown,
  visitor: string | null,
  deps: AssistantDeps,
): Promise<AssistantResult> {
  const request: AssistantRequest | null = parseAssistantRequest(raw);
  if (request === null) return { reply: { status: "invalid" }, trace: null };

  const persona = assistantPersona(tenant.presentation);
  const lang = detectLanguage(request.question);

  // A plan: the engine decides, the model explains (ADR-039).
  const intent = request.intent ?? detectPlanIntent(request.question);
  if (intent) return askPlan(tenant, request, intent, lang, persona, visitor, deps);
  const item = pageHasItem(request.page.kind)
    ? await deps.page(tenant.tenantId, request.page).catch(() => null)
    : null;
  const page = item?.label ?? null;
  const context: AnswerContext = {
    persona,
    lang,
    site: siteOf(tenant),
    today: today(deps.now(), tenant.timezone),
    page,
    history: request.history,
    question: request.question,
  };
  // Rephrase only when the question cannot be searched as it is (ADR-038).
  const plan =
    lang === "en" || request.history.length > 0 || page !== null
      ? planMessages({ page, history: request.history, question: request.question })
      : null;
  const reserve = (plan ? estimateTokens(plan) + PLAN_OUTPUT : 0) + answerReservation(context);

  const session = await deps.session(
    {
      tenantId: tenant.tenantId,
      profile: "assistant",
      reserveTokens: Math.min(reserve, AI_PROFILE_SETTINGS.assistant.maxInputTokens * 2),
      visitor,
    },
    async (call) => {
      let query = request.question;
      if (plan) {
        try {
          query =
            parsePlan(
              (await call({ messages: plan, maxOutputTokens: PLAN_OUTPUT, attempts: 1 })).text,
            ) ?? request.question;
        } catch (error) {
          // Without the rephrased words, the question as it is still finds something.
          if (!(error instanceof AiStepFailed)) throw error;
        }
      }
      // Asked from a place's page: its name joins the search («¿qué hay aquí?»).
      if (item && !query.toLocaleLowerCase("es").includes(item.title.toLocaleLowerCase("es"))) {
        query = `${query} ${item.title}`;
      }
      let found = await deps.search(tenant.tenantId, query, SEARCH_RESULTS);
      if (found.length === 0 && query !== request.question) {
        found = await deps.search(tenant.tenantId, request.question, SEARCH_RESULTS);
      }
      const passages = bestPassages(found);
      const answer = await call({
        messages: answerMessages(context, passages),
        maxOutputTokens: ANSWER_OUTPUT,
      });
      return { query, passages, parsed: parseAnswer(answer.text, passages) };
    },
  );

  const noticeContext = {
    assistantName: persona.name,
    contact: tenant.presentation.contact,
    hasTours: tenant.hasTours,
    lang,
  };
  if (session.outcome !== "answered") {
    return {
      reply: { status: "notice", lang, notice: aiNotice(session.outcome, noticeContext) },
      trace: null,
    };
  }
  const { parsed, passages, query } = session.value;
  const trace: AssistantTrace = {
    lang,
    planned: plan !== null,
    query,
    retrieved: [...new Set(passages.map(sourceKey))],
    cited: [...new Set(parsed.passages.map(sourceKey))],
    invalidCitations: parsed.invalidCitations,
    usedSite: parsed.usedSite,
    wellFormed: parsed.wellFormed,
    inputTokens: session.usage.inputTokens,
    outputTokens: session.usage.outputTokens,
    latencyMs: session.latencyMs,
  };
  if (parsed.text === "") {
    // The model wrote nothing usable (its whole budget went to reasoning): no answer.
    return {
      reply: { status: "notice", lang, notice: aiNotice("provider_error", noticeContext) },
      trace,
    };
  }

  const sources: PublicCitation[] = [];
  const seen = new Set<string>();
  for (const passage of parsed.passages) {
    const citation = publicCitation(passage);
    const key = `${citation.href ?? ""}|${citation.title}|${citation.page ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(citation);
  }
  if (parsed.usedSite) {
    sources.push({
      title: tenant.presentation.identity.siteName,
      label: lang === "en" ? "Portal details" : "Datos del portal",
      href: null,
      page: null,
      ended: false,
    });
  }
  const contact = noticeContext.contact;
  const phone = contact.phone?.trim();
  const email = contact.email?.trim();
  return {
    reply: {
      status: "answered",
      lang,
      speaker: persona.name,
      blocks: parsed.blocks,
      sources,
      abstained: parsed.abstained,
      links: parsed.abstained ? portalSectionLinks(lang, tenant.hasTours) : [],
      contact:
        parsed.abstained && (phone || email)
          ? { ...(phone ? { phone } : {}), ...(email ? { email } : {}) }
          : null,
    },
    trace,
  };
}

async function askPlan(
  tenant: AssistantTenant,
  request: AssistantRequest,
  intent: PlanIntent,
  lang: AssistantLanguage,
  persona: ReturnType<typeof assistantPersona>,
  visitor: string | null,
  deps: AssistantDeps,
): Promise<AssistantResult> {
  const started = Date.now();
  let answer;
  try {
    answer = await answerPlan(
      {
        tenantId: tenant.tenantId,
        timezone: tenant.timezone,
        siteName: tenant.presentation.identity.siteName,
        hasTours: tenant.hasTours,
      },
      { request, intent, lang, persona, today: today(deps.now(), tenant.timezone), visitor },
      deps,
    );
  } catch {
    const notice = aiNotice("provider_error", {
      assistantName: persona.name,
      contact: tenant.presentation.contact,
      hasTours: tenant.hasTours,
      lang,
    });
    return { reply: { status: "notice", lang, notice }, trace: null };
  }
  return {
    reply: {
      status: "answered",
      lang,
      speaker: persona.name,
      blocks: answer.blocks,
      sources: [],
      abstained: false,
      links: answer.links,
      contact: null,
      plan: answer.plan,
    },
    trace: {
      lang,
      planned: false,
      query: "",
      retrieved: [],
      cited: [],
      invalidCitations: 0,
      usedSite: false,
      wellFormed: answer.explained,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      latencyMs: Date.now() - started,
      plan: { intent, stops: answer.keys },
    },
  };
}
