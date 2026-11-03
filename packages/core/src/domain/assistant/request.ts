import { z } from "zod";

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
});

export interface AssistantRequest {
  readonly question: string;
  readonly history: readonly AssistantTurn[];
  readonly page: AssistantPage;
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
  return { question, history, page };
}
