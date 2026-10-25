"use client";

import {
  CONTENT_IMAGE_RULES,
  checkDeclaredImage,
  DESTINATION_LIMITS,
  type ImageProblem,
} from "@rikuy/core";
import { useId, useRef, useState } from "react";

import { confirmContentImageUploadAction, startContentImageUploadAction } from "../actions";
import { QUOTA_MESSAGES } from "@/lib/quota-messages";

export interface EditorImage {
  readonly assetId: string;
  readonly version: number;
  readonly alt: string;
  /** Short-lived preview (signed URL of the 480 px derivative), if known. */
  readonly previewUrl: string | null;
}

const MAX_MB = CONTENT_IMAGE_RULES.maxBytes / (1024 * 1024);

const PROBLEMS: Readonly<Record<ImageProblem, string>> = {
  unsupported_type: "Usa fotos JPG, PNG o WebP.",
  too_heavy: `La foto pesa más de ${MAX_MB} MB. Redúcela e inténtalo de nuevo.`,
  type_mismatch:
    "El archivo no es del tipo que indica su nombre. Expórtalo de nuevo como JPG, PNG o WebP.",
  too_small: `La foto es muy pequeña: necesita al menos ${CONTENT_IMAGE_RULES.minSide} px por lado.`,
  too_large: `La foto es demasiado grande: hasta ${CONTENT_IMAGE_RULES.maxSide} px por lado.`,
  unreadable: "No pudimos leer la foto. Prueba con otro archivo.",
};

const FAILURES = {
  forbidden: "Tu rol no permite subir fotos.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  rate_limited: "Hiciste muchas subidas seguidas. Espera unos minutos.",
  not_uploaded: "La foto no terminó de subirse. Inténtalo de nuevo.",
  not_found: "No encontramos esa subida. Inténtalo de nuevo.",
  error: "No pudimos subir la foto. Inténtalo de nuevo.",
} as const;

type UploadResult =
  | { readonly ok: true; readonly image: Omit<EditorImage, "alt"> }
  | { readonly ok: false; readonly message: string };

/** Uploads one photo: reserve → PUT straight to Storage → server checks the bytes. */
async function uploadPhoto(org: string, file: File): Promise<UploadResult> {
  const declared = checkDeclaredImage(CONTENT_IMAGE_RULES, file.type, file.size);
  if (declared) return { ok: false, message: PROBLEMS[declared] };
  try {
    const start = await startContentImageUploadAction(org, { mime: file.type, bytes: file.size });
    if (start.status === "invalid") return { ok: false, message: PROBLEMS[start.problem] };
    if (start.status === "over_quota")
      return { ok: false, message: QUOTA_MESSAGES[start.resource] };
    if (start.status !== "upload") return { ok: false, message: FAILURES[start.status] };
    const sent = await fetch(start.uploadUrl, {
      method: "PUT",
      headers: { "content-type": start.mime },
      body: file,
    });
    if (!sent.ok) return { ok: false, message: FAILURES.error };
    const done = await confirmContentImageUploadAction(org, start.versionId);
    if (done.status === "rejected") return { ok: false, message: PROBLEMS[done.problem] };
    if (done.status !== "ready") return { ok: false, message: FAILURES[done.status] };
    return { ok: true, image: { ...done.image, previewUrl: done.previewUrl } };
  } catch {
    return { ok: false, message: FAILURES.error };
  }
}

const ACCEPT = CONTENT_IMAGE_RULES.mimes.join(",");

function Thumb({ image, label }: { readonly image: EditorImage | null; readonly label: string }) {
  return (
    <div className="photo-thumb" data-empty={image === null}>
      {image?.previewUrl ? (
        // Short-lived signed URL of a private derivative: next/image would cache it past expiry.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image.previewUrl} alt="" />
      ) : (
        <span>{label}</span>
      )}
    </div>
  );
}

function AltInput({
  value,
  label,
  disabled,
  invalid,
  onChange,
}: {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        maxLength={DESTINATION_LIMITS.alt}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        aria-invalid={invalid ? true : undefined}
        onChange={(event) => onChange(event.target.value.replace(/\s*\n\s*/gu, " "))}
      />
      <span id={`${id}-hint`} className="field-hint">
        Describe lo que se ve, para quien no puede ver la foto (obligatorio).
      </span>
    </div>
  );
}

export function CoverField({
  org,
  value,
  disabled,
  altInvalid,
  onChange,
}: {
  readonly org: string;
  readonly value: EditorImage | null;
  readonly disabled: boolean;
  readonly altInvalid: boolean;
  readonly onChange: (image: EditorImage | null) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMessage({ text: "Subiendo y revisando la foto…", failed: false });
    const result = await uploadPhoto(org, file);
    setBusy(false);
    if (!result.ok) return setMessage({ text: result.message, failed: true });
    onChange({ ...result.image, alt: value?.alt ?? "" });
    setMessage({ text: "Foto lista. Escribe su descripción y guarda.", failed: false });
  }

  return (
    <fieldset className="photo-field" disabled={disabled}>
      <legend>Foto de portada</legend>
      <div className="photo-row">
        <Thumb image={value} label="Sin portada" />
        <div className="photo-controls">
          <input
            ref={input}
            id={id}
            type="file"
            accept={ACCEPT}
            className="visually-hidden photo-input"
            disabled={disabled || busy}
            aria-describedby={`${id}-status`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void choose(file);
            }}
          />
          <div className="photo-actions">
            <label htmlFor={id} className="button button-quiet" aria-disabled={disabled || busy}>
              {busy ? "Subiendo…" : value ? "Reemplazar portada" : "Subir portada"}
            </label>
            {value ? (
              <button
                type="button"
                className="button button-quiet"
                onClick={() => onChange(null)}
                disabled={busy}
              >
                Quitar portada
              </button>
            ) : null}
          </div>
          {value ? (
            <AltInput
              value={value.alt}
              label="Descripción de la portada"
              disabled={disabled}
              invalid={altInvalid}
              onChange={(alt) => onChange({ ...value, alt })}
            />
          ) : null}
        </div>
      </div>
      <span
        id={`${id}-status`}
        className={message?.failed ? "field-error" : "field-hint"}
        role="status"
        aria-live="polite"
      >
        {message?.text ??
          `JPG, PNG o WebP de hasta ${MAX_MB} MB y al menos ${CONTENT_IMAGE_RULES.minSide} px.`}
      </span>
    </fieldset>
  );
}

export function GalleryField({
  org,
  value,
  disabled,
  invalidAlts,
  onChange,
}: {
  readonly org: string;
  readonly value: readonly EditorImage[];
  readonly disabled: boolean;
  readonly invalidAlts: ReadonlySet<number>;
  readonly onChange: (images: EditorImage[]) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const room = DESTINATION_LIMITS.gallery - value.length;

  async function add(files: File[]) {
    if (files.length === 0) return;
    const accepted = files.slice(0, room);
    setBusy(true);
    const added: EditorImage[] = [];
    const failures: string[] = [];
    for (const [index, file] of accepted.entries()) {
      setMessage({ text: `Subiendo foto ${index + 1} de ${accepted.length}…`, failed: false });
      const result = await uploadPhoto(org, file);
      if (result.ok) added.push({ ...result.image, alt: "" });
      else failures.push(`${file.name}: ${result.message}`);
    }
    setBusy(false);
    onChange([...value, ...added]);
    if (files.length > accepted.length)
      failures.push(`La galería admite hasta ${DESTINATION_LIMITS.gallery} fotos.`);
    setMessage(
      failures.length > 0
        ? { text: failures.join(" "), failed: true }
        : {
            text: `${added.length === 1 ? "Foto agregada" : `${added.length} fotos agregadas`}. Escribe sus descripciones y guarda.`,
            failed: false,
          },
    );
  }

  const move = (from: number, to: number) => {
    const next = [...value];
    const [item] = next.splice(from, 1);
    if (item) next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <fieldset className="photo-field" disabled={disabled}>
      <legend>Galería</legend>
      {value.length === 0 ? <p className="field-hint">Sin fotos en la galería.</p> : null}
      <ol className="gallery-list">
        {value.map((image, index) => (
          <li key={`${image.assetId}/${image.version}/${index}`} className="photo-row">
            <Thumb image={image} label={`Foto ${index + 1}`} />
            <div className="photo-controls">
              <AltInput
                value={image.alt}
                label={`Descripción de la foto ${index + 1}`}
                disabled={disabled}
                invalid={invalidAlts.has(index)}
                onChange={(alt) =>
                  onChange(value.map((item, at) => (at === index ? { ...item, alt } : item)))
                }
              />
              <div className="photo-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  Subir<span className="visually-hidden"> la foto {index + 1}</span>
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={index === value.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  Bajar<span className="visually-hidden"> la foto {index + 1}</span>
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => onChange(value.filter((_, at) => at !== index))}
                >
                  Quitar<span className="visually-hidden"> la foto {index + 1}</span>
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <input
        id={id}
        type="file"
        accept={ACCEPT}
        multiple
        className="visually-hidden photo-input"
        disabled={disabled || busy || room <= 0}
        aria-describedby={`${id}-status`}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void add(files);
        }}
      />
      <div className="photo-actions">
        <label
          htmlFor={id}
          className="button button-quiet"
          aria-disabled={disabled || busy || room <= 0}
        >
          {busy ? "Subiendo…" : "Agregar fotos"}
        </label>
      </div>
      <span
        id={`${id}-status`}
        className={message?.failed ? "field-error" : "field-hint"}
        role="status"
        aria-live="polite"
      >
        {message?.text ??
          `Hasta ${DESTINATION_LIMITS.gallery} fotos; puedes elegir varias a la vez.`}
      </span>
    </fieldset>
  );
}
