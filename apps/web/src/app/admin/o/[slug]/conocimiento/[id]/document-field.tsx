"use client";

import {
  checkDeclaredDocument,
  DOCUMENT_PROBLEM_TEXT,
  type DocumentVersionView,
} from "@rikuy/core";
import { useEffect, useId, useState, type ChangeEvent } from "react";

import { QUOTA_MESSAGES } from "@/lib/quota-messages";

import { documentStatusAction, startDocumentUploadAction, submitDocumentAction } from "../actions";

const FAILURES = {
  forbidden: "Tu rol ya no permite subir documentos en este municipio.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para subir el documento.",
  rate_limited: "Hiciste muchas subidas seguidas. Espera unos minutos e inténtalo de nuevo.",
  not_uploaded: "El documento no terminó de subirse. Inténtalo de nuevo.",
  not_found: "No encontramos esa subida. Inténtalo de nuevo.",
  error: "No pudimos subir el documento. Revisa tu conexión e inténtalo de nuevo.",
} as const;

const NUMBER = new Intl.NumberFormat("es-BO");

/** Some systems give no type for .txt or .pdf files: the extension says it. */
function mimeOf(file: File): string {
  if (file.type !== "") return file.type;
  if (/\.txt$/iu.test(file.name)) return "text/plain";
  if (/\.pdf$/iu.test(file.name)) return "application/pdf";
  return "";
}

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

export type DocumentValue = { readonly assetId: string; readonly version: number } | null;

function describe(view: DocumentVersionView): string {
  const format =
    view.manifest?.format === "pdf" || view.declaredMime === "application/pdf" ? "PDF" : "Texto";
  if (view.status === "ready" && view.manifest) {
    const pages =
      view.manifest.pages === null
        ? "sin páginas numeradas"
        : view.manifest.pages === 1
          ? "1 página"
          : `${NUMBER.format(view.manifest.pages)} páginas`;
    return `${format} leído: ${pages}, ${NUMBER.format(view.manifest.characters)} caracteres de texto.`;
  }
  if (view.status === "rejected") {
    return `No se puede usar. ${DOCUMENT_PROBLEM_TEXT[view.problem ?? "unreadable"]}`;
  }
  if (view.job?.status === "dead_letter") {
    return "No se pudo leer después de varios intentos. El equipo de la plataforma puede reintentarlo.";
  }
  return `${format} subido. Leyendo su texto… (puedes guardar el borrador mientras tanto).`;
}

/**
 * The document of a knowledge item (TXT or PDF with text, up to 20 MB): sent straight to
 * private Storage, then read in the background. Never shown on the portal.
 */
export function DocumentField({
  org,
  value,
  initialView,
  disabled,
  error,
  onChange,
}: {
  readonly org: string;
  readonly value: DocumentValue;
  readonly initialView: DocumentVersionView | null;
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly onChange: (value: DocumentValue) => void;
}) {
  const id = useId();
  const [view, setView] = useState<DocumentVersionView | null>(initialView);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const busy = percent !== null;

  // While the text is being read, ask again every few seconds.
  const reading =
    value !== null &&
    (view === null || view.status === "processing" || view.status === "uploading");
  useEffect(() => {
    if (!reading || value === null) return;
    const timer = window.setInterval(() => {
      void documentStatusAction(org, value).then((next) => {
        if (next) setView(next);
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [reading, org, value]);

  async function send(file: File) {
    const mime = mimeOf(file);
    const declared = checkDeclaredDocument(mime, file.size);
    if (declared) return setMessage({ text: DOCUMENT_PROBLEM_TEXT[declared], failed: true });
    setMessage({ text: "Preparando la subida…", failed: false });
    const start = await startDocumentUploadAction(org, { mime, bytes: file.size });
    if (start.status === "invalid") {
      return setMessage({ text: DOCUMENT_PROBLEM_TEXT[start.problem], failed: true });
    }
    if (start.status === "over_quota") {
      return setMessage({ text: QUOTA_MESSAGES[start.resource], failed: true });
    }
    if (start.status !== "upload")
      return setMessage({ text: FAILURES[start.status], failed: true });

    setPercent(0);
    const sent = await put(start.uploadUrl, file, start.mime, setPercent);
    setPercent(null);
    if (!sent) return setMessage({ text: FAILURES.error, failed: true });
    const submitted = await submitDocumentAction(org, start.versionId);
    if (submitted.status !== "processing" && submitted.status !== "ready") {
      return setMessage({
        text:
          submitted.status === "rejected"
            ? DOCUMENT_PROBLEM_TEXT.unreadable
            : FAILURES[submitted.status as keyof typeof FAILURES],
        failed: true,
      });
    }
    setView(null);
    setMessage({ text: `Se subió «${file.name}».`, failed: false });
    onChange({ assetId: start.assetId, version: start.version });
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    send(file).catch(() => {
      setPercent(null);
      setMessage({ text: FAILURES.error, failed: true });
    });
  }

  return (
    <fieldset disabled={disabled || busy}>
      <legend>Documento</legend>
      <p id={`${id}-hint`} className="field-hint">
        Opcional. Un PDF con texto (no escaneado) o un archivo .txt, de hasta 20 MB. Solo lo lee el
        asistente: no se publica en el portal.
      </p>
      {value === null ? (
        <p className="cell-detail">Sin documento.</p>
      ) : (
        <p className={view?.status === "rejected" ? "field-error" : "cell-detail"} role="status">
          {view ? describe(view) : "Leyendo su texto…"}
        </p>
      )}
      <div className="photo-actions">
        <input
          id={`${id}-file`}
          type="file"
          className="visually-hidden"
          accept=".pdf,.txt,application/pdf,text/plain"
          aria-describedby={`${id}-hint`}
          onChange={choose}
          disabled={disabled || busy}
        />
        <label htmlFor={`${id}-file`} className="button button-quiet" aria-disabled={busy}>
          {busy ? "Subiendo…" : value === null ? "Subir documento" : "Reemplazar documento"}
        </label>
        {value !== null ? (
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              setView(null);
              setMessage(null);
              onChange(null);
            }}
          >
            Quitar documento
          </button>
        ) : null}
      </div>
      {percent !== null ? (
        <>
          <progress className="upload-progress" max={100} value={percent} aria-hidden="true" />
          <p className="field-hint" role="status">
            Subiendo… {percent} %
          </p>
        </>
      ) : null}
      {message ? (
        <p className={message.failed ? "field-error" : "field-hint"} role="status">
          {message.text}
        </p>
      ) : null}
      {error ? <p className="field-error">{error}</p> : null}
    </fieldset>
  );
}
