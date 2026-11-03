import type { PlanIntent } from "./engine";

/**
 * Which questions are plans (ADR-039). The panel's buttons send the intent explicitly; a
 * typed question is recognized only by clear phrases, so «¿qué hay en la plaza?» stays a
 * question for the published texts.
 */

const fold = (text: string) =>
  text
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const PATTERNS: readonly (readonly [PlanIntent, RegExp])[] = [
  [
    "route",
    /\b(ruta sugerida|una ruta|que ruta|ruta para (hoy|caminar|recorrer|visitar|conocer)|armame una ruta|itinerario|suggested route|a route|walking route|route for (today|me)|itinerary)\b/u,
  ],
  [
    "today",
    /\b(plan para hoy|plan de hoy|un plan (para|de) hoy|que (puedo |podemos )?(hacer|visitar|ver) hoy|que hago hoy|que hacer hoy|hoy que (puedo |podemos )?(hacer|visitar|ver)|plan for today|today s plan|what (can|should) (i|we) do today|what to do today|things to do today)\b/u,
  ],
  [
    "nearby",
    /\b(que (hay|puedo (ver|visitar|hacer)) cerca|cerca de (mi|aqui|donde estoy)|lo mas cercano|mas cerca de mi|lugares cercanos|what s near|whats near|what is near|near me|nearby|close to me|closest)\b/u,
  ],
];

export function detectPlanIntent(question: string): PlanIntent | null {
  const text = fold(question);
  for (const [intent, pattern] of PATTERNS) if (pattern.test(text)) return intent;
  return null;
}
