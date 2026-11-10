"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ModelUpload } from "../modelos/model-upload";
import { deleteMediaAction, applyReplacementAction } from "./library-actions";
import { PanoramaUpload } from "./panorama-upload";

/**
 * Replace, use the new version in the tours, delete (ADR-048). Nothing here changes what
 * visitors see: a new version goes to the tours' drafts, and only what no tour ever used is
 * deleted.
 */

const WORDS = {
  panorama: { one: "este panorama", deleted: "Se borró el panorama." },
  model: { one: "este modelo", deleted: "Se borró el modelo." },
} as const;

const APPLY_FAILURES: Record<string, string> = {
  not_ready: "La versión nueva todavía no está lista.",
  stale: "Ya hay una versión más nueva. Recarga la página.",
  forbidden: "Tu rol no permite cambiar los tours.",
  not_found: "Ya no existe. Recarga la página.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo usar la versión nueva. Inténtalo de nuevo.",
};

const DELETE_FAILURES: Record<string, string> = {
  in_use: "Un tour empezó a usarlo: ya no se puede borrar. Recarga la página.",
  busy: "Se está procesando: espera a que termine.",
  forbidden: "Solo propietarios y administradores pueden borrar.",
  not_found: "Ya no existe. Recarga la página.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo borrar. Inténtalo de nuevo.",
};

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many.replace("{n}", String(count));
}

export function MediaAssetActions({
  slug,
  kind,
  assetId,
  readyVersionId,
  outdatedTours,
  deletable,
  replacing,
  processing,
  canReplace,
  canDelete,
}: {
  readonly slug: string;
  readonly kind: "panorama" | "model";
  readonly assetId: string;
  /** The current version, when it is ready. */
  readonly readyVersionId: string | null;
  /** Tours whose draft (or published version) still uses an older version. */
  readonly outdatedTours: number;
  readonly deletable: boolean;
  /** A new version is uploading or being processed. */
  readonly replacing: boolean;
  /** A version (the first one or a new one) is being processed. */
  readonly processing: boolean;
  readonly canReplace: boolean;
  readonly canDelete: boolean;
}) {
  const router = useRouter();
  const words = WORDS[kind];
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);

  function applyNewVersion() {
    if (!readyVersionId) return;
    startTransition(async () => {
      const result = await applyReplacementAction(slug, readyVersionId);
      if (result.status === "applied") {
        setMessage({
          text: `${plural(
            result.tours,
            "Quedó en el borrador de 1 tour.",
            "Quedó en el borrador de {n} tours.",
          )} Publícalo${result.tours === 1 ? "" : "s"} para que los visitantes vean la versión nueva.`,
          failed: false,
        });
        router.refresh();
      } else {
        setMessage({ text: APPLY_FAILURES[result.status] ?? APPLY_FAILURES.error!, failed: true });
      }
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteMediaAction(slug, assetId);
      if (result.status === "deleted") {
        setMessage({ text: words.deleted, failed: false });
        router.refresh();
      } else {
        setConfirming(false);
        setMessage({
          text: DELETE_FAILURES[result.status] ?? DELETE_FAILURES.error!,
          failed: true,
        });
      }
    });
  }

  return (
    <div className="media-actions">
      {canReplace && readyVersionId && outdatedTours > 0 ? (
        <div className="notice" role="note">
          <p>
            {plural(
              outdatedTours,
              "Un tour todavía usa la versión anterior.",
              "{n} tours todavía usan la versión anterior.",
            )}{" "}
            Al usar la nueva, queda en su borrador: los visitantes la ven cuando lo publiques.
          </p>
          <button type="button" className="button" disabled={pending} onClick={applyNewVersion}>
            {pending ? "Cambiando…" : "Usar la versión nueva en los tours"}
          </button>
        </div>
      ) : null}

      {canReplace && !replacing ? (
        kind === "panorama" ? (
          <PanoramaUpload slug={slug} replaces={assetId} />
        ) : (
          <ModelUpload slug={slug} replaces={assetId} />
        )
      ) : null}

      {canDelete ? (
        deletable ? (
          <div className="inline-form">
            {confirming ? (
              <>
                <span className="field-hint">
                  ¿Borrar {words.one}? Se borran sus archivos y no se puede deshacer.
                </span>
                <button
                  key="confirm"
                  type="button"
                  className="button button-danger"
                  disabled={pending}
                  onClick={remove}
                >
                  {pending ? "Borrando…" : "Sí, borrar"}
                </button>
                <button
                  key="cancel"
                  type="button"
                  className="button button-quiet"
                  onClick={() => setConfirming(false)}
                >
                  Cancelar
                </button>
              </>
            ) : (
              <button
                key="ask"
                type="button"
                className="button button-quiet"
                onClick={() => {
                  setMessage(null);
                  setConfirming(true);
                }}
              >
                Borrar
              </button>
            )}
          </div>
        ) : (
          <p className="field-hint">
            {processing
              ? "Se está procesando: se podrá borrar cuando termine."
              : `No se puede borrar: un tour usa ${words.one} (o lo usó en una versión que se puede restaurar). Para cambiarlo, reemplázalo.`}
          </p>
        )
      ) : null}

      {message ? (
        <p className={message.failed ? "field-error" : "field-hint"} role="status">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
