"use client";

import {
  FAQ_LIMITS,
  FAQ_TOPIC_NAMES,
  FAQ_TOPICS,
  type CopilotSourceLink,
  type FaqTopic,
} from "@rikuy/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { createFaqDraftAction, proposeFaqAction } from "../actions";

interface Proposal {
  readonly answered: boolean;
  readonly sources: readonly CopilotSourceLink[];
}

const PROPOSE_MESSAGES: Readonly<Record<string, string>> = {
  invalid: "Escribe la pregunta en una línea, de 3 a 120 caracteres.",
  forbidden: "Tu rol no permite crear preguntas con el Copilot.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "El Copilot no pudo responder esta vez. Prueba de nuevo.",
};

const CREATE_MESSAGES: Readonly<Record<string, string>> = {
  invalid: "Escribe la pregunta en una línea, de 3 a 120 caracteres.",
  slug_taken: "Ya hay una pregunta igual. Búscala en la lista de preguntas frecuentes.",
  forbidden: "Tu rol no permite crear preguntas.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
};

export function FaqProposer({
  org,
  initialQuestion,
}: {
  readonly org: string;
  readonly initialQuestion: string;
}) {
  const router = useRouter();
  const id = useId();
  const [question, setQuestion] = useState(initialQuestion);
  const [answer, setAnswer] = useState("");
  const [topic, setTopic] = useState<FaqTopic>("other");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [message, setMessage] = useState("");
  const [proposing, startProposing] = useTransition();
  const [creating, startCreating] = useTransition();

  function propose() {
    setMessage("");
    startProposing(async () => {
      const result = await proposeFaqAction({ org, question });
      if (result.status === "proposed") {
        setQuestion(result.question);
        setAnswer(result.answer ?? "");
        setTopic(result.topic);
        setProposal({ answered: result.answer !== null, sources: result.sources });
      } else if (result.status === "notice") {
        setMessage(result.message);
      } else if (result.status !== "idle") {
        setMessage(PROPOSE_MESSAGES[result.status] ?? PROPOSE_MESSAGES.error ?? "");
      }
    });
  }

  function create() {
    setMessage("");
    startCreating(async () => {
      const result = await createFaqDraftAction({ org, question, answer, topic });
      if (result.status === "created") {
        router.push(`/o/${org}/preguntas-frecuentes/${result.contentId}`);
      } else if (result.status !== "idle") {
        setMessage(CREATE_MESSAGES[result.status] ?? CREATE_MESSAGES.error ?? "");
      }
    });
  }

  const busy = proposing || creating;
  return (
    <div className="form destination-form">
      <fieldset disabled={busy}>
        <legend>Lo que preguntan</legend>
        <div className="field">
          <label htmlFor={`${id}-question`}>Pregunta</label>
          <span id={`${id}-question-hint`} className="field-hint">
            Como la hacen los visitantes. Puedes corregirla antes y después de la propuesta.
          </span>
          <input
            id={`${id}-question`}
            value={question}
            maxLength={FAQ_LIMITS.question}
            aria-describedby={`${id}-question-hint`}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </div>
        <div className="form-actions">
          <button
            type="button"
            className={proposal ? "button button-quiet" : "button"}
            disabled={busy || question.trim().length < 3}
            onClick={propose}
          >
            {proposing
              ? "El Copilot está leyendo lo publicado…"
              : proposal
                ? "Proponer de nuevo"
                : "Proponer con el Copilot"}
          </button>
        </div>
      </fieldset>

      {proposal ? (
        <fieldset disabled={busy}>
          <legend>Propuesta</legend>
          {proposal.answered ? (
            <p className="field-hint" role="status">
              El Copilot propone esta respuesta con lo publicado. Revísala: puedes cambiarla.
            </p>
          ) : (
            <p className="notice" role="status">
              Nada de lo publicado responde esta pregunta. Crea el borrador con la pregunta y
              escribe tú la respuesta; si hace falta, publica primero la información (un destino, un
              servicio o un texto del asistente).
            </p>
          )}
          <div className="field">
            <label htmlFor={`${id}-answer`}>Respuesta</label>
            <span id={`${id}-answer-hint`} className="field-hint">
              En una o dos oraciones. Para publicarla hace falta una respuesta.
            </span>
            <textarea
              id={`${id}-answer`}
              rows={3}
              value={answer}
              maxLength={FAQ_LIMITS.answer}
              aria-describedby={`${id}-answer-hint`}
              onChange={(event) => setAnswer(event.target.value.replace(/\s*\n\s*/gu, " "))}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-topic`}>Tema</label>
            <select
              id={`${id}-topic`}
              value={topic}
              onChange={(event) => setTopic(event.target.value as FaqTopic)}
            >
              {FAQ_TOPICS.map((option) => (
                <option key={option} value={option}>
                  {FAQ_TOPIC_NAMES[option]}
                </option>
              ))}
            </select>
          </div>
          {proposal.sources.length > 0 ? (
            <section aria-labelledby={`${id}-sources`} className="faq-proposal-sources">
              <h2 id={`${id}-sources`} className="preview-label">
                De dónde la sacó
              </h2>
              <ul>
                {proposal.sources.map((source) => (
                  <li key={`${source.href ?? ""}|${source.title}`}>
                    {source.label}:{" "}
                    {source.href ? <Link href={source.href}>{source.title}</Link> : source.title}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="form-actions">
            <button
              type="button"
              className="button"
              disabled={busy || question.trim().length < 3}
              onClick={create}
            >
              {creating ? "Creando…" : "Crear el borrador"}
            </button>
          </div>
          <p className="field-hint">
            Se guarda como borrador en «Preguntas frecuentes»: ahí la revisas y, si tu rol lo
            permite, la publicas.
          </p>
        </fieldset>
      ) : null}

      <p className="form-error" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
