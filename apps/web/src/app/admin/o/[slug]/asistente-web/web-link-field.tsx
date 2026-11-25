"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import { saveWebLinkAction, type WebLinkState } from "./actions";

/**
 * «Página en la web del municipio» (ADR-071): where the assistant's answers lead for this item
 * inside the municipality's website, or always when it has no public portal. Only on one of
 * its authorized websites; owners and admins change it.
 */

function message(state: WebLinkState): string | null {
  switch (state.status) {
    case "invalid":
      return "Escribe la dirección completa de la página, por ejemplo https://www.municipio.gob.bo/turismo/museo.";
    case "origin":
      return "Esa página no está en una web autorizada del municipio. Pide al operador de Rikuy que la autorice.";
    case "forbidden":
      return "Solo propietarios y administradores pueden cambiar este enlace.";
    case "not_found":
      return "No se encontró. Recarga la página.";
    case "signed_out":
      return "Tu sesión venció. Inicia sesión de nuevo.";
    case "error":
      return "No se pudo guardar. Inténtalo de nuevo.";
    default:
      return null;
  }
}

export function WebLinkField({
  org,
  contentId,
  url,
  origins,
  canChange,
}: {
  readonly org: string;
  readonly contentId: string;
  readonly url: string | null;
  readonly origins: readonly string[];
  readonly canChange: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const [value, setValue] = useState(url ?? "");
  const [state, action, pending] = useActionState(
    async (previous: WebLinkState, formData: FormData) => {
      const next = await saveWebLinkAction(previous, formData);
      if (next.status === "saved") {
        setValue(next.url ?? "");
        router.refresh();
      }
      return next;
    },
    { status: "idle" } satisfies WebLinkState,
  );
  const error = message(state);

  return (
    <section aria-labelledby={`${id}-heading`} className="web-link-field">
      <h2 id={`${id}-heading`}>Página en la web del municipio</h2>
      <p className="field-hint">
        Si la web del municipio tiene una página sobre esto, las respuestas del asistente llevan ahí
        cuando se pregunta desde esa web. Webs autorizadas: {origins.join(", ")}.
      </p>
      {canChange ? (
        <form action={action} className="web-link-form">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="contentId" value={contentId} />
          <div className="field">
            <label htmlFor={`${id}-url`}>Dirección de la página</label>
            <input
              id={`${id}-url`}
              name="url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={`${origins[0] ?? "https://"}/…`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
            />
          </div>
          {error ? (
            <p id={`${id}-error`} className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          {state.status === "saved" ? (
            <p className="notice" role="status">
              {state.url ? "Se guardó el enlace." : "Se quitó el enlace."}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" className="button button-quiet" disabled={pending}>
              {pending ? "Guardando…" : "Guardar el enlace"}
            </button>
            {url ? (
              <button
                type="submit"
                name="clear"
                value="1"
                formNoValidate
                className="button button-quiet"
                disabled={pending}
              >
                Quitar el enlace
              </button>
            ) : null}
          </div>
        </form>
      ) : url ? (
        <p>
          <a href={url} target="_blank" rel="noopener noreferrer">
            {url}
            <span className="visually-hidden"> (se abre en otra pestaña)</span>
          </a>
        </p>
      ) : (
        <p className="field-hint">Todavía no tiene. Lo ponen propietarios y administradores.</p>
      )}
    </section>
  );
}
