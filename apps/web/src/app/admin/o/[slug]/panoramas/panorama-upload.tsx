"use client";

import { checkDeclaredImage, PANORAMA_RULES } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useId, useState, type ChangeEvent } from "react";

import { startPanoramaUploadAction, submitPanoramaAction } from "./actions";
import { PANORAMA_HINT, PANORAMA_PROBLEMS } from "./labels";

const FAILURES = {
  forbidden: "Tu rol ya no permite subir panoramas en este municipio.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para subir la foto.",
  rate_limited: "Hiciste muchas subidas seguidas. Espera unos minutos e inténtalo de nuevo.",
  not_uploaded: "La foto no terminó de subirse. Inténtalo de nuevo.",
  not_found: "No encontramos esa subida. Inténtalo de nuevo.",
  error: "No pudimos subir la foto. Revisa tu conexión e inténtalo de nuevo.",
} as const;

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "uploading"; readonly percent: number }
  | { readonly kind: "working"; readonly message: string }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/** PUT with upload progress (fetch has none): a 50 MB photo takes a while on a phone. */
function put(url: string, file: File, mime: string, onProgress: (percent: number) => void) {
  return new Promise<boolean>((resolve) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("content-type", mime);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.floor((event.loaded / event.total) * 100));
    };
    request.onload = () => resolve(request.status >= 200 && request.status < 300);
    request.onerror = () => resolve(false);
    request.onabort = () => resolve(false);
    request.send(file);
  });
}

/**
 * Panorama upload: the server reserves a version and signs a one-time URL, the browser sends
 * the file straight to Storage, and the server enqueues the processing job. The list below
 * shows the progress; the page can be closed.
 */
export function PanoramaUpload({ slug }: { readonly slug: string }) {
  const id = useId();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "uploading" || phase.kind === "working";

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    send(file).catch(() => setPhase({ kind: "failed", message: FAILURES.error }));
  }

  async function send(file: File) {
    const declared = checkDeclaredImage(PANORAMA_RULES, file.type, file.size);
    if (declared) return setPhase({ kind: "failed", message: PANORAMA_PROBLEMS[declared] });

    setPhase({ kind: "working", message: "Preparando la subida…" });
    const start = await startPanoramaUploadAction(slug, { mime: file.type, bytes: file.size });
    if (start.status === "invalid") {
      return setPhase({ kind: "failed", message: PANORAMA_PROBLEMS[start.problem] });
    }
    if (start.status !== "upload") {
      return setPhase({ kind: "failed", message: FAILURES[start.status] });
    }

    setPhase({ kind: "uploading", percent: 0 });
    const sent = await put(start.uploadUrl, file, start.mime, (percent) =>
      setPhase({ kind: "uploading", percent }),
    );
    if (!sent) return setPhase({ kind: "failed", message: FAILURES.error });

    setPhase({ kind: "working", message: "Enviando a procesar…" });
    const submitted = await submitPanoramaAction(slug, start.versionId);
    if (submitted.status !== "processing" && submitted.status !== "ready") {
      const status = submitted.status === "rejected" ? "error" : submitted.status;
      return setPhase({ kind: "failed", message: FAILURES[status] });
    }
    setPhase({
      kind: "done",
      message:
        "Foto subida. Se está procesando; aparecerá como «Listo» en la lista en unos segundos.",
    });
    router.refresh();
  }

  const message =
    phase.kind === "idle"
      ? ""
      : phase.kind === "uploading"
        ? `Subiendo la foto… ${phase.percent} %`
        : phase.message;

  return (
    <div className="field panorama-upload">
      <span id={`${id}-hint`} className="field-hint">
        {PANORAMA_HINT}
      </span>
      <div className="photo-actions">
        <input
          id={id}
          type="file"
          className="visually-hidden"
          accept={PANORAMA_RULES.mimes.join(",")}
          disabled={busy}
          aria-describedby={`${id}-hint ${id}-status`}
          aria-invalid={phase.kind === "failed" ? true : undefined}
          onChange={choose}
        />
        <label htmlFor={id} className="button" aria-disabled={busy}>
          {busy ? "Subiendo…" : "Subir un panorama"}
        </label>
      </div>
      {phase.kind === "uploading" ? (
        <progress className="upload-progress" max={100} value={phase.percent} aria-hidden="true" />
      ) : null}
      <span
        id={`${id}-status`}
        className={phase.kind === "failed" ? "field-error" : "field-hint"}
        role="status"
        aria-live="polite"
      >
        {message}
      </span>
    </div>
  );
}
