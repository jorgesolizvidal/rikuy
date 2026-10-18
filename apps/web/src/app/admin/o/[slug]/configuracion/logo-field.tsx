"use client";

import { checkDeclaredLogo, LOGO_RULES, type LogoProblem } from "@rikuy/core";
import { useId, useRef, useState, type ChangeEvent } from "react";

import { confirmLogoUploadAction, startLogoUploadAction } from "./actions";

export interface LogoSelection {
  readonly assetId: string;
  readonly version: string;
  readonly previewUrl: string | null;
}

interface LogoFieldProps {
  readonly slug: string;
  readonly disabled: boolean;
  readonly hasLogo: boolean;
  readonly previewUrl: string | null;
  readonly error?: string | undefined;
  readonly onChange: (logo: LogoSelection | null) => void;
}

const MAX_MB = LOGO_RULES.maxBytes / (1024 * 1024);

const PROBLEMS: Readonly<Record<LogoProblem, string>> = {
  unsupported_type: "Usa una imagen PNG, JPG o WebP (los archivos SVG no se admiten).",
  too_heavy: `La imagen pesa más de ${MAX_MB} MB. Redúcela e inténtalo de nuevo.`,
  type_mismatch:
    "El archivo no es del tipo que indica su nombre. Expórtalo de nuevo como PNG, JPG o WebP.",
  too_small: `La imagen es muy pequeña: necesita al menos ${LOGO_RULES.minSide} px por lado.`,
  too_large: `La imagen es demasiado grande: hasta ${LOGO_RULES.maxSide} px por lado.`,
  unreadable: "No pudimos leer la imagen. Prueba con otro archivo.",
};

const FAILURES = {
  forbidden: "Tu rol ya no permite cambiar el logo de este municipio.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para subir el logo.",
  rate_limited: "Hiciste muchas subidas seguidas. Espera unos minutos e inténtalo de nuevo.",
  not_uploaded: "La imagen no terminó de subirse. Inténtalo de nuevo.",
  not_found: "No encontramos esa subida. Inténtalo de nuevo.",
  error: "No pudimos subir el logo. Inténtalo de nuevo en unos segundos.",
} as const;

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly message: string }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Logo upload in three steps: the server reserves a version and signs a one-time URL, the
 * browser sends the file straight to Storage, and the server inspects the real bytes. The
 * brand only references the result; nothing is public until the brand is published.
 */
export function LogoField({
  slug,
  disabled,
  hasLogo,
  previewUrl,
  error,
  onChange,
}: LogoFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "working";

  function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // choosing the same file again must trigger a new upload
    if (!file) return;
    send(file).catch(() => setPhase({ kind: "failed", message: FAILURES.error }));
  }

  async function send(file: File) {
    const declared = checkDeclaredLogo(file.type, file.size);
    if (declared) return setPhase({ kind: "failed", message: PROBLEMS[declared] });

    setPhase({ kind: "working", message: "Subiendo la imagen…" });
    const start = await startLogoUploadAction(slug, { mime: file.type, bytes: file.size });
    if (start.status === "invalid") {
      return setPhase({ kind: "failed", message: PROBLEMS[start.problem] });
    }
    if (start.status !== "upload") {
      return setPhase({ kind: "failed", message: FAILURES[start.status] });
    }

    const sent = await fetch(start.uploadUrl, {
      method: "PUT",
      headers: { "content-type": start.mime },
      body: file,
    });
    if (!sent.ok) return setPhase({ kind: "failed", message: FAILURES.error });

    setPhase({ kind: "working", message: "Revisando la imagen…" });
    const confirmed = await confirmLogoUploadAction(slug, start.versionId);
    if (confirmed.status === "rejected") {
      return setPhase({ kind: "failed", message: PROBLEMS[confirmed.problem] });
    }
    if (confirmed.status !== "ready") {
      return setPhase({ kind: "failed", message: FAILURES[confirmed.status] });
    }
    onChange({
      assetId: confirmed.logo.assetId,
      version: String(confirmed.logo.version),
      previewUrl: confirmed.previewUrl,
    });
    setPhase({
      kind: "done",
      message: "Logo listo. Publica la marca para que aparezca en el portal.",
    });
  }

  function remove() {
    onChange(null);
    setPhase({
      kind: "done",
      message: "Logo quitado. Al publicar, el portal mostrará las iniciales.",
    });
    input.current?.focus();
  }

  const hint = `PNG, JPG o WebP de hasta ${MAX_MB} MB y al menos ${LOGO_RULES.minSide} px por lado. Mejor con fondo transparente. Sin logo, el portal muestra las iniciales del nombre corto.`;
  const message = error ?? (phase.kind === "idle" ? "" : phase.message);
  const failed = Boolean(error) || phase.kind === "failed";

  return (
    <div className="field logo-field">
      <span id={`${id}-label`}>Logo</span>
      <span id={`${id}-hint`} className="field-hint">
        {hint}
      </span>
      <div className="logo-row">
        <div className="logo-thumb" data-empty={!hasLogo}>
          {hasLogo && previewUrl ? (
            // Short-lived signed URL from Storage: next/image would cache it past expiry.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="Logo elegido" />
          ) : (
            <span>{hasLogo ? "Logo elegido" : "Sin logo"}</span>
          )}
        </div>
        <div className="logo-actions">
          <input
            ref={input}
            id={id}
            type="file"
            className="visually-hidden logo-input"
            accept={LOGO_RULES.mimes.join(",")}
            disabled={disabled || busy}
            aria-describedby={`${id}-hint ${id}-status`}
            aria-invalid={failed ? true : undefined}
            onChange={upload}
          />
          <label htmlFor={id} className="button button-quiet" aria-disabled={disabled || busy}>
            {busy ? "Subiendo…" : hasLogo ? "Reemplazar logo" : "Subir logo"}
          </label>
          {hasLogo ? (
            <button
              type="button"
              className="button button-quiet"
              onClick={remove}
              disabled={disabled || busy}
            >
              Quitar logo
            </button>
          ) : null}
        </div>
      </div>
      <span
        id={`${id}-status`}
        className={failed ? "field-error" : "field-hint"}
        role="status"
        aria-live="polite"
      >
        {message}
      </span>
    </div>
  );
}
