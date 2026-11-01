"use client";

import { KNOWLEDGE_LIMITS } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import {
  createKnowledgeAction,
  searchKnowledgeAction,
  type CreateKnowledgeState,
  type SearchKnowledgeState,
} from "./actions";

const CREATE_MESSAGES: Partial<Record<CreateKnowledgeState["status"], string>> = {
  invalid_title: "Escribe el nombre en una línea, hasta 120 caracteres.",
  slug_taken: "Ya hay un conocimiento con un nombre igual. Usa otro nombre.",
  forbidden: "Tu rol no permite crear conocimiento.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
};

export function NewKnowledgeForm({ org }: { readonly org: string }) {
  const router = useRouter();
  const id = useId();
  const [state, action, pending] = useActionState(createKnowledgeAction, {
    status: "idle",
  } satisfies CreateKnowledgeState);
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (state.status === "created" && state.contentId) {
      router.push(`/o/${org}/conocimiento/${state.contentId}`);
    }
  }, [state, org, router]);

  const message = CREATE_MESSAGES[state.status];
  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="org" value={org} />
      <div className="field">
        <label htmlFor={`${id}-title`}>Nombre</label>
        <input
          id={`${id}-title`}
          name="title"
          value={title}
          maxLength={KNOWLEDGE_LIMITS.title}
          required
          aria-describedby={`${id}-hint`}
          aria-invalid={state.status === "invalid_title" ? true : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
        <span id={`${id}-hint`} className="field-hint">
          Por ejemplo, «Libro histórico del municipio» o «Horarios y servicios del museo».
        </span>
      </div>
      <button type="submit" className="button" disabled={pending || title.trim() === ""}>
        {pending ? "Creando…" : "Crear"}
      </button>
      {message ? (
        <span className="field-error" role="status">
          {message}
        </span>
      ) : null}
    </form>
  );
}

const SEARCH_MESSAGES: Partial<Record<SearchKnowledgeState["status"], string>> = {
  invalid: "Escribe una pregunta de entre 2 y 300 caracteres.",
  forbidden: "Tu rol ya no permite ver el conocimiento de este municipio.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No pudimos buscar. Inténtalo de nuevo en unos segundos.",
};

/** Characters of a passage shown before «ver todo» (a passage can be ~2 000). */
const PREVIEW = 280;

/**
 * «Probar la búsqueda»: the passages the assistant would read to answer, with the citation
 * a visitor would see. No AI involved, no tokens spent.
 */
export function KnowledgeSearchForm({ org }: { readonly org: string }) {
  const id = useId();
  const [state, action, pending] = useActionState(searchKnowledgeAction, {
    status: "idle",
  } satisfies SearchKnowledgeState);

  return (
    <div className="knowledge-search">
      <form action={action} className="invite-form" role="search">
        <input type="hidden" name="org" value={org} />
        <div className="field">
          <label htmlFor={`${id}-query`}>Pregunta de un visitante</label>
          <input
            id={`${id}-query`}
            name="query"
            type="search"
            maxLength={300}
            required
            placeholder="¿Qué se conmemora el 2 de agosto?"
          />
        </div>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Buscando…" : "Buscar"}
        </button>
      </form>
      <div aria-live="polite">
        {SEARCH_MESSAGES[state.status] ? (
          <p className="field-error" role="status">
            {SEARCH_MESSAGES[state.status]}
          </p>
        ) : null}
        {state.status === "ok" && state.results ? (
          state.results.length === 0 ? (
            <p className="notice" role="status">
              No encontramos nada publicado sobre «{state.query}». Con esta pregunta, el asistente
              diría que no tiene esa información.
            </p>
          ) : (
            <>
              <p className="field-hint" role="status">
                {state.results.length === 1
                  ? "1 pasaje encontrado"
                  : `${state.results.length} pasajes encontrados`}{" "}
                para «{state.query}», del más al menos relevante.
              </p>
              <ol className="passage-list">
                {state.results.map((result) => (
                  <li key={result.key}>
                    <p className="passage-source">
                      <span className="status-pill" data-status="published">
                        {result.citation.label}
                      </span>{" "}
                      <span>{result.citation.title}</span>
                      {result.citation.page ? (
                        <span className="cell-detail"> · {result.citation.page}</span>
                      ) : null}
                      {result.citation.ended ? (
                        <span className="cell-detail"> · ya terminó</span>
                      ) : null}
                    </p>
                    <p className="passage-text">
                      {result.text.length <= PREVIEW
                        ? result.text
                        : `${result.text.slice(0, PREVIEW).trimEnd()}…`}
                    </p>
                    {result.text.length <= PREVIEW ? null : (
                      <details className="passage-more">
                        <summary>Ver el pasaje completo</summary>
                        <p className="passage-text">{result.text}</p>
                      </details>
                    )}
                    {result.citation.href ? (
                      <p className="cell-detail">Enlace de la cita: {result.citation.href}</p>
                    ) : (
                      <p className="cell-detail">
                        Documento solo para el asistente: la cita no lleva enlace.
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}
