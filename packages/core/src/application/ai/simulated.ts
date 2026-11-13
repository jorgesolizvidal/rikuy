import type { AiMessage } from "../../contracts/ai";
import { ANSWER_TAG, EXPLAIN_TAG, PLAN_TAG } from "../../domain/assistant/prompts";
import { COPILOT_ASK_TAG, COPILOT_PROPOSE_TAG } from "../../domain/copilot/prompts";
import { RECOMMEND_TAG } from "../../domain/copilot/recommendations";
import type { SpeechTranscriber } from "./dictation";
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
      const answer = system.startsWith(COPILOT_ASK_TAG)
        ? simulatedCopilotAnswer(text)
        : system.startsWith(COPILOT_PROPOSE_TAG)
          ? simulatedProposal(system, text)
          : system.startsWith(RECOMMEND_TAG)
            ? simulatedRecommendations(text)
            : system.startsWith(PLAN_TAG)
              ? simulatedPlan(text)
              : system.startsWith(ANSWER_TAG)
                ? simulatedAssistantAnswer(text)
                : system.startsWith(EXPLAIN_TAG)
                  ? simulatedExplanation(text)
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

/**
 * The Copilot's answer: how many items the snapshot has and the first one, citing it and
 * the plan's usage. «[simular:cita-inventada]» cites labels that do not exist.
 */
function simulatedCopilotAnswer(text: string): string {
  const items = [...text.matchAll(/^\[(C\d+)\] (.+?) ·/gmu)];
  const first = items[0];
  if (text.includes("[simular:cita-inventada]")) {
    return "Respuesta simulada del Copilot con fuentes que no existen.\nFUENTES: C99, F9";
  }
  const lines = [
    `Respuesta simulada del Copilot: el municipio tiene ${items.length} contenido${items.length === 1 ? "" : "s"}.`,
  ];
  if (first) lines.push(`- ${first[2]} es el primero de la lista.`);
  lines.push(`FUENTES: ${first ? `${first[1]}, ` : ""}U`);
  return lines.join("\n");
}

/**
 * A proposal with exactly the fields asked (read from the format in the instructions).
 * «[simular:sin-cambios]» proposes the current values back (nothing new to save).
 */
function simulatedProposal(system: string, text: string): string {
  const target = /^\[A\] (.+)$/mu.exec(text)?.[1] ?? "el contenido";
  const same = text.includes("[simular:sin-cambios]");
  const current = (label: string) =>
    new RegExp(`^${label} actual: (.*)$`, "mu").exec(text)?.[1] ?? "";
  const lines: string[] = [];
  if (/^NOMBRE: </mu.test(system)) lines.push(`NOMBRE: ${current("Nombre")}`);
  if (/^RESUMEN: </mu.test(system)) {
    lines.push(
      same
        ? `RESUMEN: ${current("Resumen")}`
        : `RESUMEN: Resumen propuesto por el Copilot para ${target}: un lugar para visitar con calma y conocer su historia.`,
    );
  }
  if (/^DESCRIPCION: </mu.test(system)) {
    lines.push(
      same
        ? `DESCRIPCION: ${current("Descripcion")}`
        : `DESCRIPCION: Descripción propuesta por el Copilot para la ${target}, con lo que cuentan sus textos publicados.`,
    );
  }
  if (/^TEXTO:$/mu.test(system)) {
    lines.push(
      "TEXTO:",
      "## Qué ver",
      `Texto propuesto por el Copilot para ${target}.`,
      "",
      "- Un recorrido tranquilo",
      "- Fotos al atardecer",
      "FIN_TEXTO",
    );
  }
  lines.push(`FUENTES: A${text.includes("[F1]") ? ", F1" : ""}`);
  return lines.join("\n");
}

/**
 * Recommendations: one per section of facts, resting on its first fact and repeating its
 * figures. «[simular:cifra-inventada]» anywhere in the facts (a visitor's question, say) adds
 * one with a figure no fact has and one citing a fact that does not exist: both are dropped.
 */
function simulatedRecommendations(text: string): string {
  const blocks: string[] = [];
  for (const section of text.split(/\n\n/u)) {
    const first = /^\[(H\d+)\] (.+)$/mu.exec(section);
    if (!first) continue;
    const name = section.split("\n")[0]?.replace(/:$/u, "") ?? "";
    blocks.push(
      [
        `RECOMENDACION: Revisa «${name}» en el panel`,
        `POR QUE: La plataforma dice: ${first[2]}`,
        `HECHOS: ${first[1]}`,
      ].join("\n"),
    );
  }
  if (text.includes("[simular:cifra-inventada]")) {
    blocks.push(
      "RECOMENDACION: Duplica las visitas del portal\nPOR QUE: Con 98765 vistas más el portal crecería.\nHECHOS: H1",
      "RECOMENDACION: Revisa un dato que no existe\nPOR QUE: Lo dice un hecho que no está.\nHECHOS: H99",
    );
  }
  return blocks.join("\n\n");
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
 * drop it), «[simular:enlace]» writes a web address (it must never reach the visitor),
 * «[simular:eco]» copies the whole message it was given, as a real model once did (S03), and
 * «[simular:no-sabe]» says it has nothing even with passages, as a real model does when what
 * it read does not answer the question (ADR-053).
 */
function simulatedAssistantAnswer(text: string): string {
  const question = questionOf(text).slice(0, 120);
  if (question.includes("[simular:eco]")) return `${text}\nFUENTES: F1, M`;
  if (question.toLowerCase().includes("[simular:no-sabe]")) {
    return `No encontré información publicada sobre «${question}».\nFUENTES: ninguna`;
  }
  if (question.includes("[simular:cita-falsa]")) {
    return `Respuesta simulada con una fuente inventada.\nFUENTES: F9`;
  }
  const link = question.includes("[simular:enlace]") ? " Más en https://ejemplo.invalid/x." : "";
  const first = /^\[F1\] (.+)$/mu.exec(text)?.[1];
  return first
    ? `Respuesta simulada a «${question}», según ${first}.${link}\nFUENTES: F1`
    : `No encontré información publicada sobre «${question}».${link}\nFUENTES: ninguna`;
}

/** A plan in words: the names of its stops, in order (the simulated model adds nothing). */
function simulatedExplanation(text: string): string {
  const names = [...text.matchAll(/^\d+\. ([^·\n]+)/gmu)].map((match) => match[1]?.trim());
  return names.length > 0
    ? `Plan simulado con ${names.length} ${names.length === 1 ? "parada" : "paradas"}: ${names.join(", ")}.`
    : "Plan simulado sin paradas.";
}

/** The messages of «Probar la IA»: the smallest request that proves the key and the quota. */
export const PROBE_MESSAGES: readonly AiMessage[] = [
  { role: "system", content: "Responde solo con la palabra: listo" },
  { role: "user", content: "¿Estás disponible?" },
];

/** What the simulated transcriber hears in any recording (ADR-041). */
export const SIMULATED_DICTATION = "¿Qué lugares puedo visitar?";
export const SIMULATED_TRANSCRIBER_MODEL = "simulated/whisper-1";

/**
 * A speech provider without network or key (AI_PROVIDER=simulated). Any recording says
 * SIMULATED_DICTATION, lasting 1 s per 16 KB. Bytes of a marker inside the recording (a
 * test writes them into a WAV) fail on purpose: «[simular:caida]», «[simular:rechazo]» and
 * «[simular:silencio]» (nothing said).
 */
export function createSimulatedTranscriber(): SpeechTranscriber {
  return {
    name: "simulated",
    model: SIMULATED_TRANSCRIBER_MODEL,
    async transcribe(request) {
      const bytes = new TextDecoder("latin1").decode(request.audio);
      if (bytes.includes("[simular:caida]")) throw new AiProviderError("unavailable", 503);
      if (bytes.includes("[simular:rechazo]")) throw new AiProviderError("error", 400);
      const silent = bytes.includes("[simular:silencio]");
      const text = silent
        ? "Subtítulos realizados por la comunidad de Amara.org"
        : SIMULATED_DICTATION;
      return {
        text,
        durationSeconds: Math.max(1, Math.round(request.audio.length / 16_384)),
        segments: [{ text, noSpeechProb: silent ? 0.9 : 0.01 }],
        model: SIMULATED_TRANSCRIBER_MODEL,
      };
    },
  };
}
