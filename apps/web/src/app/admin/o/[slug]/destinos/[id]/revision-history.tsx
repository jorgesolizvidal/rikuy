"use client";

import { useActionState, useEffect, useState } from "react";

import { restoreRevisionAction, type RevisionActionState } from "../actions";

export interface HistoryEntry {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly title: string;
  readonly sealedAt: string;
}

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

const MESSAGES: Partial<Record<RevisionActionState["status"], string>> = {
  conflict: "Esa versión ya es la publicada. Recarga la página.",
  forbidden: "Solo propietarios y administradores pueden volver a una versión anterior.",
  not_found: "Esa versión ya no existe. Recarga la página.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo cambiar la versión publicada. Inténtalo de nuevo.",
};

function RestoreButton({
  org,
  contentId,
  entry,
}: {
  readonly org: string;
  readonly contentId: string;
  readonly entry: HistoryEntry;
}) {
  const [state, action, pending] = useActionState(restoreRevisionAction, {
    status: "idle",
  } satisfies RevisionActionState);
  const [confirming, setConfirming] = useState(false);
  // The editor must start again from what is now public: reload the whole page.
  useEffect(() => {
    if (state.status === "restored") window.location.reload();
  }, [state]);

  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="contentId" value={contentId} />
      <input type="hidden" name="revisionId" value={entry.revisionId} />
      {confirming ? (
        <>
          <button type="submit" className="button button-danger" disabled={pending}>
            Confirmar: publicar la versión {entry.revisionNo}
          </button>
          <button
            type="button"
            className="button button-quiet"
            onClick={() => setConfirming(false)}
          >
            Cancelar
          </button>
        </>
      ) : (
        <button type="button" className="button button-quiet" onClick={() => setConfirming(true)}>
          Volver a esta versión
        </button>
      )}
      {MESSAGES[state.status] ? (
        <span className="field-error" role="status">
          {MESSAGES[state.status]}
        </span>
      ) : null}
    </form>
  );
}

export function RevisionHistory({
  org,
  contentId,
  entries,
  publishedRevisionId,
  canPublish,
}: {
  readonly org: string;
  readonly contentId: string;
  readonly entries: readonly HistoryEntry[];
  readonly publishedRevisionId: string | null;
  readonly canPublish: boolean;
}) {
  if (entries.length === 0) {
    return <p className="field-hint">Todavía no se ha publicado.</p>;
  }
  return (
    <ol className="history-list" reversed>
      {entries.map((entry) => {
        const live = entry.revisionId === publishedRevisionId;
        return (
          <li key={entry.revisionId} data-live={live}>
            <div>
              <span className="history-version">Versión {entry.revisionNo}</span>
              {live ? (
                <span className="status-pill" data-status="published">
                  Publicada
                </span>
              ) : null}
              <span className="cell-detail">
                {entry.title} · {DATE.format(new Date(entry.sealedAt))}
              </span>
            </div>
            {!live && canPublish ? (
              <RestoreButton org={org} contentId={contentId} entry={entry} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
