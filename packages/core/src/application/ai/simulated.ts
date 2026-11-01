import type { AiMessage } from "../../contracts/ai";
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
      const answer = simulatedAnswer(text);
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

/** The messages of «Probar la IA»: the smallest request that proves the key and the quota. */
export const PROBE_MESSAGES: readonly AiMessage[] = [
  { role: "system", content: "Responde solo con la palabra: listo" },
  { role: "user", content: "¿Estás disponible?" },
];
