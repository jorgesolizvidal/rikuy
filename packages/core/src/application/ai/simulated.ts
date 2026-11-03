import type { AiMessage } from "../../contracts/ai";
import { ANSWER_TAG, PLAN_TAG } from "../../domain/assistant/prompts";
import { AiProviderError, estimateTokens, type AiProvider } from "./gateway";

/**
 * A provider that answers without any network or key, for local development and tests
 * (AI_PROVIDER=simulated). Deterministic: the same messages give the same answer and the
 * same token counts. A user message containing one of the markers fails on purpose, to see
 * each degraded state end to end.
 */
export const SIMULATED_MODEL = "simulated/echo-1";

export const SIMULATED_FAILURES = {
  "[simular:caida]": "unavailable",
  "[simular:lento]": "timeout",
  "[simular:saturado]": "rate_limited",
  "[simular:rechazo]": "error",
} as const;

export function createSimulatedAiProvider(options: { readonly delayMs?: number } = {}): AiProvider {
  return {
    name: "simulated",
    model: SIMULATED_MODEL,
    async complete(request, signal) {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const text = lastUser?.content ?? "";
      for (const [marker, kind] of Object.entries(SIMULATED_FAILURES)) {
        if (text.includes(marker)) throw new AiProviderError(kind, kind === "error" ? 400 : 503);
      }
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        });
      }
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      const answer = system.startsWith(PLAN_TAG)
        ? simulatedPlan(text)
        : system.startsWith(ANSWER_TAG)
          ? simulatedAssistantAnswer(text)
          : simulatedAnswer(text);
      return {
        text: answer,
        inputTokens: estimateTokens(request.messages),
        outputTokens: Math.min(
          request.maxOutputTokens,
          estimateTokens([{ role: "assistant", content: answer }]),
        ),
        model: SIMULATED_MODEL,
      };
    },
  };
}

function simulatedAnswer(question: string): string {
  const trimmed = question.trim().slice(0, 120);
  return trimmed ? `Respuesta simulada a: «${trimmed}»` : "Respuesta simulada.";
}

/** The question at the end of the assistant's messages (after «Pregunta…:»). */
function questionOf(text: string): string {
  const index = text.lastIndexOf(":\n");
  return (index >= 0 ? text.slice(index + 2) : text).trim();
}

/** Rephrasing: the question's own words (the simulated model knows no synonyms). */
function simulatedPlan(text: string): string {
  return `BUSCAR: ${questionOf(text)
    .replace(/[¿?¡!.,]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()}`;
}

/**
 * An answer in the assistant's format: it cites the first passage it was given, or says it
 * has nothing. «[simular:cita-falsa]» cites a passage that does not exist (validation must
 * drop it) and «[simular:enlace]» writes a web address (it must never reach the visitor).
 */
function simulatedAssistantAnswer(text: string): string {
  const question = questionOf(text).slice(0, 120);
  if (question.includes("[simular:cita-falsa]")) {
    return `Respuesta simulada con una fuente inventada.\nFUENTES: F9`;
  }
  const link = question.includes("[simular:enlace]") ? " Más en https://ejemplo.invalid/x." : "";
  const first = /^\[F1\] (.+)$/mu.exec(text)?.[1];
  return first
    ? `Respuesta simulada a «${question}», según ${first}.${link}\nFUENTES: F1`
    : `No encontré información publicada sobre «${question}».${link}\nFUENTES: ninguna`;
}

/** The messages of «Probar la IA»: the smallest request that proves the key and the quota. */
export const PROBE_MESSAGES: readonly AiMessage[] = [
  { role: "system", content: "Responde solo con la palabra: listo" },
  { role: "user", content: "¿Estás disponible?" },
];
