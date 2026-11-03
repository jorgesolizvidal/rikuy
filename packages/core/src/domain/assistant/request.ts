import { z } from "zod";

import type { PlanIntent } from "../plan/engine";
import { ASSISTANT_LIMITS } from "./limits";
import {
  ASSISTANT_PAGE_KINDS,
  ASSISTANT_SLUG_PATTERN,
  pageHasItem,
  type AssistantPage,
} from "./page";
import type { AssistantTurn } from "./prompts";

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
  /** A plan asked with the panel's buttons (ADR-039). */
  intent: z.enum(["nearby", "today", "route"]).nullable().optional(),
  /**
   * Straight-line meters from the visitor to each place («destination:slug», «event:slug»),
   * computed on their phone. Never coordinates: the position stays on the device.
   */
  distances: z.record(z.string().max(100), z.number()).optional(),
});

/** Place keys the phone may send distances for. */
const PLACE_KEY = /^(?:destination|event):[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface AssistantRequest {
  readonly question: string;
  readonly history: readonly AssistantTurn[];
  readonly page: AssistantPage;
  readonly intent: PlanIntent | null;
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
  return { question, history, page, intent: parsed.data.intent ?? null, distances };
}
