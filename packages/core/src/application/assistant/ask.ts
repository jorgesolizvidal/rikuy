import { AI_PROFILE_SETTINGS } from "../../contracts/ai";
import type { KnowledgePassage, PublicCitation } from "../../contracts/knowledge";
import type { TenantPresentation } from "../../contracts/presentation";
import { parseAnswer, parsePlan, type AnswerBlock } from "../../domain/assistant/answer";
import { detectLanguage, type AssistantLanguage } from "../../domain/assistant/language";
import { detectHandoff } from "../../domain/assistant/handoff";
import { ASSISTANT_LIMITS } from "../../domain/assistant/limits";
import {
  pageHasItem,
  type AssistantPage,
  type AssistantPageKind,
} from "../../domain/assistant/page";
import type { AssistantTurnKind } from "../../domain/assistant/turns";
import { assistantPersona } from "../../domain/assistant/persona";
import {
  answerMessages,
  PASSAGE_BLOCK_MAX,
  planMessages,
  type AnswerContext,
  type AssistantSite,
} from "../../domain/assistant/prompts";
import {
  isTourPage,
  parseAssistantRequest,
  type AssistantRequest,
} from "../../domain/assistant/request";
import {
  admitsNotKnowing,
  unansweredText,
  type UnansweredQuestion,
} from "../../domain/assistant/unanswered";
import type { PlanIntent, PlanVisit } from "../../domain/plan/engine";
import { detectPlanIntent, detectPlanVisit } from "../../domain/plan/intent";
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
  /**
   * The municipality has its public portal (ADR-071). Without it the assistant names no
   * section of a portal; absent means it has one.
   */
  readonly portal?: boolean;
}

export interface AssistantDeps {
  /** The gateway (server/ai-gateway.ts → runAiSession). */
  session<T>(
    input: AiSessionInput,
    work: (call: AiCall) => Promise<T>,
  ): Promise<AiSessionResult<T>>;
  /** ai_api.search_knowledge: published passages of this municipality, best first. */
  search(tenantId: string, query: string, limit: number): Promise<KnowledgePassage[]>;
  /**
   * ai_api.place_notices (ADR-069): the notices in force that name the destination or event
   * the visitor is on (its page or its tour), read even when the question does not mention
   * them. Absent: no place notices (the search still finds notices that match).
   */
  placeNotices?(
    tenantId: string,
    item: { readonly kind: "destination" | "event"; readonly slug: string },
  ): Promise<KnowledgePassage[]>;
  /** The published destination, event or tour the visitor is on; null if none. */
  page(tenantId: string, page: AssistantPage): Promise<AssistantPageItem | null>;
  /** Published destinations (with hours) and upcoming events, for plans (ADR-039). */
  places(tenantId: string): Promise<AssistantPlaces>;
  /**
   * Inside a tour (ADR-040): the scene and point the browser names, resolved against the
   * published tour of that item (ai_api.tour_context); null when there is no such tour.
   */
  tourContext(
    tenantId: string,
    item: { readonly kind: "destination" | "event"; readonly slug: string },
    sceneId: string | null,
    hotspotId: string | null,
  ): Promise<TourGuideContext | null>;
  readonly now: () => Date;
}

/** What the server resolved inside a tour (ADR-040); editorial names are data. */
export interface TourGuideContext {
  readonly tourTitle: string;
  readonly scene: {
    readonly sceneId: string;
    readonly title: string;
    /** requested: the one asked for; entry: none was asked; unknown: asked, not in the tour. */
    readonly status: "requested" | "entry" | "unknown";
  };
  readonly hotspot: { readonly hotspotId: string; readonly title: string } | null;
  readonly hotspotStatus: "none" | "requested" | "unknown";
  /** The scene's point first, then the scene, its other points and the place. */
  readonly passages: readonly KnowledgePassage[];
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
  /**
   * «Quiero hablar con una persona» (ADR-073): no model call; the panel shows who to write
   * or call, with the visitor's last question written in the message.
   */
  | { readonly status: "handoff"; readonly lang: AssistantLanguage; readonly speaker: string }
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
  /** The model copied its own context: the visitor got the fixed refusal instead. */
  readonly echoed?: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  /** Inside a tour: how the scene and the point were resolved (ADR-040). */
  readonly guide?: {
    readonly scene: TourGuideContext["scene"]["status"];
    readonly hotspot: TourGuideContext["hotspotStatus"];
  };
  /** A plan's intent, outcome and stops (`kind:slug`), in order. */
  readonly plan?: {
    readonly intent: PlanIntent;
    readonly stops: readonly string[];
    /** The kind of visit of a plan for today (ADR-072). */
    readonly visit?: PlanVisit;
  };
}

/** What the visitor reads when the model copied its own context instead of answering. */
export const ECHO_REFUSAL = {
  es: "No puedo mostrar mis instrucciones ni copiar el material que uso para responder. Pregúntame por los lugares, la agenda o los servicios del municipio y te ayudo.",
  en: "I can't show my instructions or copy the material I use to answer. Ask me about the municipality's places, events or services and I'll help.",
} as const satisfies Record<AssistantLanguage, string>;

export interface AssistantResult {
  readonly reply: AssistantReply;
  readonly trace: AssistantTrace | null;
  /**
   * The gateway's request for this answer (ADR-036): the panel sends it back if the visitor
   * then takes the question to a person (ADR-073). Absent when there was none.
   */
  readonly ref?: string;
  /**
   * The question, masked, when nothing published could answer it (C1 · Paso 3, ADR-053): the
   * portal keeps it for the municipality after answering. Never for a plan, a notice (quota,
   * provider) or a refusal to copy the model's context.
   */
  readonly unanswered?: UnansweredQuestion;
  /**
   * The answer as «Estadísticas» counts it (ADR-074): kept with its channel after answering.
   * Absent without a gateway request (a typed «hablar con una persona», an invalid question).
   */
  readonly turn?: AssistantTurnRecord;
}

/** An answer of the assistant as the database keeps it (ADR-074): no text, nothing of the visitor. */
export interface AssistantTurnRecord {
  readonly requestId: string;
  readonly kind: AssistantTurnKind;
  readonly pageKind: AssistantPageKind;
  /** What it cited, as `kind:slug` (a tour as `destination_tour:slug`), up to 12. */
  readonly cited: readonly string[];
}

const TURN_CITATIONS = 12;

/** The answer's kind and citations, from what the visitor got. */
export function assistantTurnOf(
  result: Omit<AssistantResult, "turn">,
  pageKind: AssistantPageKind,
): AssistantTurnRecord | null {
  if (!result.ref) return null;
  const { reply } = result;
  if (reply.status === "notice")
    return { requestId: result.ref, kind: "notice", pageKind, cited: [] };
  if (reply.status !== "answered") return null;
  if (reply.plan) return { requestId: result.ref, kind: "plan", pageKind, cited: [] };
  const abstained = reply.abstained || result.unanswered !== undefined;
  return {
    requestId: result.ref,
    kind: abstained ? "abstained" : "answered",
    pageKind,
    cited: (result.trace?.cited ?? []).slice(0, TURN_CITATIONS),
  };
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
    sections:
      tenant.portal === false
        ? []
        : portalSectionLinks("es", tenant.hasTours).map((link) => link.label),
  };
}

/** The most the answer step may read: everything known now, plus full passages. */
function answerReservation(context: AnswerContext, passages: number): number {
  const base = estimateTokens(answerMessages(context, []));
  return base + passages * Math.ceil(PASSAGE_BLOCK_MAX / 3 + 4) + ANSWER_OUTPUT;
}

/** Inside a tour the guide reads one more passage: the scene's, its point's and the place's. */
const GUIDE_PASSAGES = ASSISTANT_LIMITS.passages + 1;

/** A notice in force reads before everything else (ADR-069). */
const NOTICES_FIRST = (a: KnowledgePassage, b: KnowledgePassage) =>
  Number(b.kind === "notice") - Number(a.kind === "notice");

/**
 * The place's notices and the scene's passages first, then what the search found, without
 * repeating one; among them, notices before the rest.
 */
export function bestPassages(
  found: readonly KnowledgePassage[],
  guide: TourGuideContext | null,
  notices: readonly KnowledgePassage[] = [],
): KnowledgePassage[] {
  const seen = new Set<string>();
  return [...notices, ...(guide?.passages ?? []), ...found]
    .filter((passage) => !seen.has(passage.chunkId) && seen.add(passage.chunkId))
    .slice(0, guide ? GUIDE_PASSAGES : ASSISTANT_LIMITS.passages)
    .sort(NOTICES_FIRST);
}

export async function askAssistant(
  tenant: AssistantTenant,
  raw: unknown,
  visitor: string | null,
  deps: AssistantDeps,
): Promise<AssistantResult> {
  const request: AssistantRequest | null = parseAssistantRequest(raw);
  if (request === null) return { reply: { status: "invalid" }, trace: null };
  const result = await answerRequest(tenant, request, visitor, deps);
  // Each answer the gateway counted, with its kind and what it cited (ADR-074).
  const turn = assistantTurnOf(result, request.page.kind);
  return turn ? { ...result, turn } : result;
}

async function answerRequest(
  tenant: AssistantTenant,
  request: AssistantRequest,
  visitor: string | null,
  deps: AssistantDeps,
): Promise<AssistantResult> {
  const persona = assistantPersona(tenant.presentation);
  const lang = detectLanguage(request.question);

  // «Quiero hablar con una persona» (ADR-073): the contact, without asking the model.
  if (request.intent === null && detectHandoff(request.question)) {
    return { reply: { status: "handoff", lang, speaker: persona.name }, trace: null };
  }

  // A plan: the engine decides, the model explains (ADR-039). A kind of visit (chosen under
  // «Plan para hoy» or written: «tengo 2 horas con los chicos») is a plan for today (ADR-072).
  const typedVisit = request.intent === null ? detectPlanVisit(request.question) : null;
  const planIntent =
    request.intent === "guide"
      ? null
      : (request.intent ??
        (typedVisit?.length
          ? "today"
          : (detectPlanIntent(request.question) ?? (typedVisit ? "today" : null))));
  if (planIntent) {
    const visit = planIntent === "today" ? (request.visit ?? typedVisit) : null;
    return askPlan(tenant, request, planIntent, visit, lang, persona, visitor, deps);
  }

  // Inside a tour: the scene and the point on screen, checked by the server (ADR-040).
  const tourItem =
    isTourPage(request.page) && request.page.slug !== null
      ? {
          kind: request.page.kind === "event_tour" ? ("event" as const) : ("destination" as const),
          slug: request.page.slug,
        }
      : null;
  // The destination or event the visitor is on (its page or its tour): its notices in force.
  const noticeItem =
    tourItem ??
    ((request.page.kind === "destination" || request.page.kind === "event") &&
    request.page.slug !== null
      ? { kind: request.page.kind, slug: request.page.slug }
      : null);
  const [item, guide, notices] = await Promise.all([
    pageHasItem(request.page.kind)
      ? deps.page(tenant.tenantId, request.page).catch(() => null)
      : Promise.resolve(null),
    tourItem
      ? deps
          .tourContext(
            tenant.tenantId,
            tourItem,
            request.tour?.sceneId ?? null,
            request.tour?.hotspotId ?? null,
          )
          .catch(() => null)
      : Promise.resolve(null),
    noticeItem && deps.placeNotices
      ? deps.placeNotices(tenant.tenantId, noticeItem).catch(() => [])
      : Promise.resolve([] as KnowledgePassage[]),
  ]);
  const page = item?.label ?? null;
  const context: AnswerContext = {
    persona,
    lang,
    site: siteOf(tenant),
    today: today(deps.now(), tenant.timezone),
    page,
    history: request.history,
    question: request.question,
    guide: guide
      ? {
          tour: guide.tourTitle,
          scene: guide.scene.title,
          sceneReplaced: guide.scene.status === "unknown",
          point: guide.hotspot?.title ?? null,
        }
      : null,
  };
  // «¿Qué estoy viendo?» (the tour's buttons): the scene's passages are enough, no search.
  const guideOnly = guide !== null && request.intent === "guide";
  // Rephrase only when the question cannot be searched as it is (ADR-038).
  const plan =
    !guideOnly && (lang === "en" || request.history.length > 0 || page !== null || guide !== null)
      ? planMessages({
          page: page ?? (guide ? `Recorrido 360° de «${guide.tourTitle}»` : null),
          history: request.history,
          question: request.question,
        })
      : null;
  // A question asked as it is that finds nothing (another word for the same thing, a typo)
  // gets one rephrasing before the answer (ADR-045).
  const fallback =
    plan === null && !guideOnly
      ? planMessages({ page: null, history: [], question: request.question })
      : null;
  const reserve =
    (plan ? estimateTokens(plan) + PLAN_OUTPUT : 0) +
    (fallback ? estimateTokens(fallback) + PLAN_OUTPUT : 0) +
    answerReservation(context, guide ? GUIDE_PASSAGES : ASSISTANT_LIMITS.passages);

  const session = await deps.session(
    {
      tenantId: tenant.tenantId,
      profile: "assistant",
      reserveTokens: Math.min(reserve, AI_PROFILE_SETTINGS.assistant.maxInputTokens * 2),
      visitor,
    },
    async (call) => {
      let query = request.question;
      if (guideOnly && guide) {
        const passages = bestPassages([], guide, notices);
        const answer = await call({
          messages: answerMessages(context, passages),
          maxOutputTokens: ANSWER_OUTPUT,
        });
        return {
          query: "",
          passages,
          parsed: parseAnswer(answer.text, passages),
          rephrased: false,
        };
      }
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
      const place = item?.title ?? guide?.tourTitle ?? null;
      if (place && !query.toLocaleLowerCase("es").includes(place.toLocaleLowerCase("es"))) {
        query = `${query} ${place}`;
      }
      let found = await deps.search(tenant.tenantId, query, SEARCH_RESULTS);
      if (found.length === 0 && query !== request.question) {
        found = await deps.search(tenant.tenantId, request.question, SEARCH_RESULTS);
      }
      let rephrased = false;
      if (found.length === 0 && fallback) {
        try {
          const words = parsePlan(
            (await call({ messages: fallback, maxOutputTokens: PLAN_OUTPUT, attempts: 1 })).text,
          );
          if (words && words !== query) {
            rephrased = true;
            found = await deps.search(tenant.tenantId, words, SEARCH_RESULTS);
            if (found.length > 0) query = words;
          }
        } catch (error) {
          // Nothing found either way: the answer says so.
          if (!(error instanceof AiStepFailed)) throw error;
        }
      }
      const passages = bestPassages(found, guide, notices);
      const answer = await call({
        messages: answerMessages(context, passages),
        maxOutputTokens: ANSWER_OUTPUT,
      });
      return { query, passages, parsed: parseAnswer(answer.text, passages), rephrased };
    },
  );

  const noticeContext = {
    assistantName: persona.name,
    contact: tenant.presentation.contact,
    hasTours: tenant.hasTours,
    lang,
  };
  const ref = session.requestId ? { ref: session.requestId } : {};
  if (session.outcome !== "answered") {
    return {
      reply: { status: "notice", lang, notice: aiNotice(session.outcome, noticeContext) },
      trace: null,
      ...ref,
    };
  }
  const { passages, query, rephrased } = session.value;
  // An answer that copies the model's instructions or its data card is never shown: the
  // visitor gets the same fixed refusal in their language, without sources (S03).
  const parsed = session.value.parsed.echoed
    ? {
        ...session.value.parsed,
        text: ECHO_REFUSAL[lang],
        blocks: [{ type: "paragraph" as const, text: ECHO_REFUSAL[lang] }],
        passages: [],
        citations: [],
        usedSite: false,
        abstained: true,
      }
    : session.value.parsed;
  const trace: AssistantTrace = {
    lang,
    planned: plan !== null || rephrased,
    query,
    retrieved: [...new Set(passages.map(sourceKey))],
    cited: [...new Set(parsed.passages.map(sourceKey))],
    invalidCitations: parsed.invalidCitations,
    usedSite: parsed.usedSite,
    wellFormed: parsed.wellFormed,
    ...(parsed.echoed ? { echoed: true } : {}),
    inputTokens: session.usage.inputTokens,
    outputTokens: session.usage.outputTokens,
    latencyMs: session.latencyMs,
    ...(guide ? { guide: { scene: guide.scene.status, hotspot: guide.hotspotStatus } } : {}),
  };
  if (parsed.text === "") {
    // The model wrote nothing usable (its whole budget went to reasoning): no answer.
    return {
      reply: { status: "notice", lang, notice: aiNotice("provider_error", noticeContext) },
      trace,
      ...ref,
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
  // Nothing published answered it (ADR-053): no citation at all, or only the portal's details
  // while saying it does not know (suggesting the phone or email is not an answer).
  const kept =
    !parsed.echoed &&
    parsed.passages.length === 0 &&
    (parsed.abstained || admitsNotKnowing(parsed.text))
      ? unansweredText(request.question)
      : null;
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
    ...ref,
    ...(kept
      ? {
          unanswered: {
            requestId: session.requestId,
            question: kept,
            lang,
            page: request.page,
            sceneId: guide && guide.scene.status !== "unknown" ? guide.scene.sceneId : null,
          },
        }
      : {}),
  };
}

async function askPlan(
  tenant: AssistantTenant,
  request: AssistantRequest,
  intent: PlanIntent,
  visit: PlanVisit | null,
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
      { request, intent, visit, lang, persona, today: today(deps.now(), tenant.timezone), visitor },
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
      plan: { intent, stops: answer.keys, ...(visit ? { visit } : {}) },
    },
    ...(answer.requestId ? { ref: answer.requestId } : {}),
  };
}
