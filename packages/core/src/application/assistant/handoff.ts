import { z } from "zod";

import { detectLanguage } from "../../domain/assistant/language";
import { parseAssistantRequest } from "../../domain/assistant/request";
import { unansweredText, type UnansweredQuestion } from "../../domain/assistant/unanswered";

/**
 * «Pidió una persona» (ADR-073): the visitor tapped WhatsApp, «Llamar» or the email after an
 * answer. The browser sends back that answer's reference, the question and its page; the
 * database keeps the question (masked) only if the reference is a recent request of this
 * municipality's assistant and of the same visitor.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const personSchema = z.object({
  ref: z.string().regex(UUID),
  question: z.string().max(4000),
  page: z.unknown().optional(),
  tour: z.unknown().optional(),
});

/** What is kept for a person request; null when nothing is worth keeping (or it is invalid). */
export function parsePersonRequest(raw: unknown): UnansweredQuestion | null {
  const parsed = personSchema.safeParse(raw);
  if (!parsed.success) return null;
  // The same rules as a question (its length, its page and its tour's scene).
  const request = parseAssistantRequest({
    question: parsed.data.question,
    page: parsed.data.page,
    tour: parsed.data.tour,
  });
  if (request === null) return null;
  const question = unansweredText(request.question);
  if (question === null) return null;
  return {
    requestId: parsed.data.ref,
    question,
    lang: detectLanguage(request.question),
    page: request.page,
    sceneId: request.tour?.sceneId ?? null,
  };
}
