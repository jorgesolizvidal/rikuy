import { z } from "zod";

import type { PlanIntent, PlanVisit } from "../plan/engine";
import { ASSISTANT_LIMITS } from "./limits";
import {
  ASSISTANT_PAGE_KINDS,
  ASSISTANT_SLUG_PATTERN,
  pageHasItem,
  type AssistantPage,
} from "./page";
import type { AssistantTurn } from "./prompts";

/** The lengths of «Plan para hoy» (ADR-072): «1 hora», «2 horas», «Medio día», «Día completo». */
export const VISIT_LENGTHS = ["1h", "2h", "half", "full"] as const;
export type VisitLengthChoice = (typeof VISIT_LENGTHS)[number];

/**
 * What the browser sends with a question (ADR-038). Everything is untrusted: the server
 * keeps the last messages, cuts each one, removes control characters and checks the page.
 */
const requestSchema = z.object({
  question: z.string().max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) }))
    .max(50)
    .optional(),
  page: z
    .object({
      kind: z.enum(ASSISTANT_PAGE_KINDS),
      slug: z.string().max(200).nullable().optional(),
    })
    .optional(),
  /** A plan asked with the panel's buttons (ADR-039), or the tour's guide button (ADR-040). */
  intent: z.enum(["nearby", "today", "route", "guide"]).nullable().optional(),
  /**
   * The kind of visit chosen under «Plan para hoy» (ADR-072): how long and whether with
   * children. Only for a plan for today.
   */
  visit: z
    .object({
      length: z.enum(VISIT_LENGTHS).nullable().optional(),
      kids: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  /**
   * Inside a 360° tour (ADR-040): the scene on screen and the point open, as IDs only. The
   * server checks them against the published tour; nothing else of the tour comes from here.
   */
  tour: z
    .object({
      sceneId: z.string().max(64).nullable().optional(),
      hotspotId: z.string().max(64).nullable().optional(),
    })
    .optional(),
  /**
   * Straight-line meters from the visitor to each place («destination:slug», «event:slug»),
   * computed on their phone. Never coordinates: the position stays on the device.
   */
  distances: z.record(z.string().max(100), z.number()).optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const uuidOrNull = (value: string | null | undefined) =>
  typeof value === "string" && UUID.test(value) ? value : null;

/** A tour's page: the guide can use the scene and the point there. */
export function isTourPage(page: AssistantPage): boolean {
  return (page.kind === "destination_tour" || page.kind === "event_tour") && page.slug !== null;
}

/** A length chosen in the panel as the engine's. */
export function visitLengthOf(choice: VisitLengthChoice): PlanVisit["length"] {
  switch (choice) {
    case "1h":
      return { kind: "hours", minutes: 60 };
    case "2h":
      return { kind: "hours", minutes: 120 };
    case "half":
      return { kind: "hours", minutes: 240 };
    case "full":
      return { kind: "full_day" };
  }
}

/** The buttons' intents: a plan (ADR-039) or the tour's guide (ADR-040). */
export type AssistantIntent = PlanIntent | "guide";

/** Place keys the phone may send distances for. */
const PLACE_KEY = /^(?:destination|event|service):[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface AssistantRequest {
  readonly question: string;
  readonly history: readonly AssistantTurn[];
  readonly page: AssistantPage;
  readonly intent: AssistantIntent | null;
  /** The kind of visit chosen in the panel (ADR-072); null when none. */
  readonly visit: PlanVisit | null;
  /** Only on a tour's page; IDs as sent (UUIDs), never trusted until the server checks them. */
  readonly tour: { readonly sceneId: string | null; readonly hotspotId: string | null } | null;
  /** Rounded to ASSISTANT_LIMITS.distanceStep; at most ASSISTANT_LIMITS.distances entries. */
  readonly distances: ReadonlyMap<string, number>;
}

function oneLine(text: string): string {
  return text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseAssistantRequest(raw: unknown): AssistantRequest | null {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const question = oneLine(parsed.data.question);
  if (question.length < 2 || question.length > ASSISTANT_LIMITS.question) return null;
  const history = (parsed.data.history ?? [])
    .map((turn) => ({
      role: turn.role,
      text: oneLine(turn.text).slice(0, ASSISTANT_LIMITS.historyMessage),
    }))
    .filter((turn) => turn.text !== "")
    .slice(-ASSISTANT_LIMITS.historyMessages);
  const kind = parsed.data.page?.kind ?? "other";
  const slug = parsed.data.page?.slug ?? null;
  const page: AssistantPage =
    pageHasItem(kind) && slug !== null && ASSISTANT_SLUG_PATTERN.test(slug)
      ? { kind, slug }
      : { kind: pageHasItem(kind) ? "other" : kind, slug: null };
  const distances = new Map<string, number>();
  for (const [key, meters] of Object.entries(parsed.data.distances ?? {})) {
    if (distances.size >= ASSISTANT_LIMITS.distances) break;
    if (!PLACE_KEY.test(key) || !Number.isFinite(meters) || meters < 0 || meters > 20_000_000) {
      continue;
    }
    const step = ASSISTANT_LIMITS.distanceStep;
    distances.set(key, Math.round(meters / step) * step);
  }
  const tour =
    isTourPage(page) && parsed.data.tour
      ? {
          sceneId: uuidOrNull(parsed.data.tour.sceneId),
          hotspotId: uuidOrNull(parsed.data.tour.hotspotId),
        }
      : null;
  // The guide's button only makes sense inside a tour.
  const intent =
    parsed.data.intent === "guide" && !isTourPage(page) ? null : (parsed.data.intent ?? null);
  const chosen = parsed.data.visit;
  const visit =
    chosen && (chosen.length || chosen.kids)
      ? {
          length: chosen.length ? visitLengthOf(chosen.length) : null,
          kids: chosen.kids === true,
        }
      : null;
  return { question, history, page, intent, visit, tour, distances };
}
