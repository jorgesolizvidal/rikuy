"use client";

import { COPILOT_LIMITS, type CopilotAnswerBlock, type CopilotSourceLink } from "@rikuy/core";
import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";

import { askCopilotAction } from "./actions";

/**
 * V1 questions (ADR-042). The conversation lives only in this page: it is never stored,
 * and leaving the page forgets it.
 */

type Turn =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly blocks: readonly CopilotAnswerBlock[];
      readonly sources: readonly CopilotSourceLink[];
    }
  | { readonly role: "notice"; readonly text: string };

const PROBLEMS = {
  invalid: "Escribe una pregunta de entre 2 y 500 caracteres.",
  forbidden: "Tu rol ya no permite usar el Copilot en este municipio.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No pudimos consultar al Copilot. Prueba de nuevo en unos segundos.",
} as const;

const SUGGESTIONS = [
  "¿Qué contenidos están incompletos?",
  "¿Qué conviene publicar primero?",
  "¿Cuánto espacio del plan estamos usando?",
];

function plain(blocks: readonly CopilotAnswerBlock[]): string {
  return blocks
    .map((block) => (block.type === "paragraph" ? block.text : block.items.join(". ")))
    .join(" ");
}

export function CopilotChat({ org, enabled }: { readonly org: string; readonly enabled: boolean }) {
  const id = useId();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  async function ask(text: string) {
    const clean = text.trim();
    if (!clean || pending) return;
    setPending(true);
    setTurns((current) => [...current, { role: "user", text: clean }]);
    setQuestion("");
    const history = turns
      .filter((turn) => turn.role !== "notice")
      .map((turn) => ({ role: turn.role, text: turn.text }));
    const reply = await askCopilotAction({ org, question: clean, history }).catch(
      () => ({ status: "error" }) as const,
    );
    setTurns((current) => [
      ...current,
      reply.status === "answered"
        ? {
            role: "assistant",
            text: plain(reply.blocks),
            blocks: reply.blocks,
            sources: reply.sources,
          }
        : {
            role: "notice",
            text: reply.status === "notice" ? reply.message : PROBLEMS[reply.status],
          },
    ]);
    setPending(false);
    input.current?.focus();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  return (
    <div className="copilot-chat">
      <div className="copilot-log" aria-live="polite" aria-busy={pending}>
        {turns.length === 0 ? (
          <p className="field-hint">
            Pregunta por el contenido del municipio, incluidos los borradores, o por el uso del
            plan. El Copilot solo lee: no publica ni cambia nada.
          </p>
        ) : null}
        {turns.map((turn, index) =>
          turn.role === "user" ? (
            <p key={index} className="copilot-turn copilot-turn-user">
              <span className="visually-hidden">Tú: </span>
              {turn.text}
            </p>
          ) : turn.role === "notice" ? (
            <p key={index} className="copilot-turn notice" role="status">
              {turn.text}
            </p>
          ) : (
            <div key={index} className="copilot-turn copilot-turn-answer">
              <span className="visually-hidden">Copilot: </span>
              {turn.blocks.map((block, blockIndex) =>
                block.type === "paragraph" ? (
                  <p key={blockIndex}>{block.text}</p>
                ) : (
                  <ul key={blockIndex}>
                    {block.items.map((item, itemIndex) => (
                      <li key={itemIndex}>{item}</li>
                    ))}
                  </ul>
                ),
              )}
              {turn.sources.length > 0 ? (
                <p className="copilot-sources">
                  Fuentes:{" "}
                  {turn.sources.map((source, sourceIndex) => (
                    <span key={sourceIndex}>
                      {sourceIndex > 0 ? " · " : ""}
                      {source.href ? (
                        <Link href={source.href}>
                          {source.label === source.title
                            ? source.title
                            : `${source.label}: ${source.title}`}
                        </Link>
                      ) : (
                        `${source.label}: ${source.title}`
                      )}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
          ),
        )}
        {pending ? <p className="field-hint">El Copilot está revisando…</p> : null}
      </div>

      {enabled ? (
        <>
          {turns.length === 0 ? (
            <div className="copilot-suggestions" role="group" aria-label="Preguntas sugeridas">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="button button-quiet"
                  disabled={pending}
                  onClick={() => void ask(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
          <form className="copilot-form" onSubmit={submit}>
            <div className="field">
              <label htmlFor={`${id}-question`}>Tu pregunta</label>
              <textarea
                id={`${id}-question`}
                ref={input}
                rows={2}
                maxLength={COPILOT_LIMITS.question}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void ask(question);
                  }
                }}
              />
            </div>
            <div className="copilot-actions">
              <button
                type="submit"
                className="button"
                disabled={pending || question.trim().length < 2}
              >
                {pending ? "Consultando…" : "Preguntar"}
              </button>
              {turns.length > 0 ? (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={pending}
                  onClick={() => setTurns([])}
                >
                  Nueva conversación
                </button>
              ) : null}
            </div>
          </form>
        </>
      ) : (
        <p className="notice" role="status">
          El Copilot no está disponible en esta plataforma por ahora. La revisión del contenido de
          abajo sigue funcionando.
        </p>
      )}
    </div>
  );
}
