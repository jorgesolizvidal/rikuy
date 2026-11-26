"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId } from "react";

import { changeEmbedOriginAction, type EmbedOriginsState } from "../actions";

const MESSAGES: Partial<Record<EmbedOriginsState["status"], string>> = {
  added: "Se autorizó la web. Llega al asistente en menos de un minuto.",
  removed: "Se quitó la web. En menos de un minuto el asistente deja de mostrarse ahí.",
  invalid:
    "Escribe solo la dirección de la web, con https (por ejemplo https://www.municipio.gob.bo), sin rutas.",
  too_many: "Un municipio puede tener hasta 10 webs.",
  not_found: "Ese municipio ya no existe.",
  forbidden: "Tu sesión de operador ya no es válida. Recarga la página.",
  error: "No se pudo guardar. Inténtalo de nuevo en unos segundos.",
};

/**
 * «Webs donde se puede insertar el asistente» (ADR-071): the operator adds or removes the
 * websites of one municipality. Anywhere else its assistant is not shown.
 */
export function EmbedOriginsForm({
  tenantId,
  displayName,
  origins,
}: {
  readonly tenantId: string;
  readonly displayName: string;
  readonly origins: readonly { readonly origin: string; readonly createdAt: string }[];
}) {
  const id = useId();
  const router = useRouter();
  const [state, dispatch, pending] = useActionState(changeEmbedOriginAction, {
    status: "idle",
  } as EmbedOriginsState);

  useEffect(() => {
    if (state.status === "added" || state.status === "removed") router.refresh();
  }, [state, router]);

  const message = MESSAGES[state.status] ?? null;
  const ok = state.status === "added" || state.status === "removed";

  return (
    <section aria-labelledby={`${id}-heading`} className="embed-section">
      <h2 id={`${id}-heading`}>Webs donde se puede insertar el asistente</h2>
      <p className="field-hint">
        Para «Solo asistente» o para un municipio que además quiere el asistente en su web propia.
        Solo en estas webs se muestra el botón y el marco del asistente de {displayName}.
      </p>
      {origins.length === 0 ? (
        <p className="notice">Ninguna todavía.</p>
      ) : (
        <ul className="embed-origins">
          {origins.map((entry) => (
            <li key={entry.origin}>
              <form action={dispatch} className="embed-origin-row">
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="origin" value={entry.origin} />
                <input type="hidden" name="intent" value="remove" />
                <code>{entry.origin}</code>
                <button type="submit" className="button button-quiet" disabled={pending}>
                  Quitar<span className="visually-hidden"> {entry.origin}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={dispatch} className="embed-origin-add">
        <input type="hidden" name="tenantId" value={tenantId} />
        <input type="hidden" name="intent" value="add" />
        <div className="field">
          <label htmlFor={`${id}-origin`}>Dirección de la web</label>
          <input
            id={`${id}-origin`}
            name="origin"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://www.municipio.gob.bo"
            required
          />
        </div>
        <button type="submit" className="button" disabled={pending}>
          Autorizar la web
        </button>
      </form>
      {message ? (
        <p className={ok ? "notice" : "field-error"} role={ok ? "status" : "alert"}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
