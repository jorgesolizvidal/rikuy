"use client";

import { isHexColor, PRESENTATION_LIMITS, SOCIAL_NETWORKS, type SocialNetwork } from "@rikuy/core";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";

import { SOCIAL_LABELS } from "@/lib/social-labels";

import { brandingAction, type BrandingFormState } from "./actions";
import type { BrandingField, BrandingValues } from "./branding-fields";
import { BrandingPreview } from "./branding-preview";

interface BrandingFormProps {
  readonly slug: string;
  readonly initial: BrandingValues;
  readonly revision: number | null;
  readonly canEdit: boolean;
}

const STATUS_MESSAGES: Readonly<Record<Exclude<BrandingFormState["status"], "idle">, string>> = {
  saved: "Borrador guardado. El portal sigue mostrando la versión publicada.",
  published: "Publicado. Los visitantes verán la nueva marca en menos de un minuto.",
  invalid: "Revisa los campos marcados.",
  conflict:
    "Otra persona cambió la marca mientras editabas, así que tus cambios no se guardaron. Recarga la página para ver la versión más reciente.",
  forbidden: "Tu rol ya no permite cambiar la marca de este municipio.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para guardar.",
  error: "No pudimos guardar los cambios. Inténtalo de nuevo en unos segundos.",
};

export function BrandingForm({ slug, initial, revision, canEdit }: BrandingFormProps) {
  const [values, setValues] = useState(initial);
  const [state, dispatch, pending] = useActionState(brandingAction, {
    status: "idle",
    revision,
  } satisfies BrandingFormState);
  const [, startTransition] = useTransition();
  const errors = state.errors ?? {};
  const formRef = useRef<HTMLFormElement>(null);

  // Move keyboard and screen-reader focus to the first field that needs attention.
  useEffect(() => {
    if (state.status !== "invalid") return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const set = <K extends keyof BrandingValues>(key: K, value: BrandingValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setSocial = (network: SocialNetwork, url: string) =>
    setValues((current) => ({ ...current, social: { ...current.social, [network]: url } }));

  // Submitted manually (not through `action=`) so React does not reset the controlled
  // fields after the action; `intent` comes from the button that was pressed.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => dispatch(formData));
  }

  return (
    <div className="branding-layout">
      <form ref={formRef} className="form branding-form" onSubmit={submit} noValidate>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="revision" value={state.revision ?? ""} />

        <fieldset disabled={!canEdit || pending}>
          <legend>Identidad</legend>
          <TextField
            field="siteName"
            label="Nombre del portal"
            hint="Aparece en la portada, en la pestaña del navegador y en Google."
            value={values.siteName}
            maxLength={PRESENTATION_LIMITS.siteName}
            onChange={(v) => set("siteName", v)}
            error={errors.siteName}
            required
          />
          <TextField
            field="shortName"
            label="Nombre corto"
            hint="Se usa en el ícono del portal y al instalarlo en el celular (hasta 12 caracteres)."
            value={values.shortName}
            maxLength={PRESENTATION_LIMITS.shortName}
            onChange={(v) => set("shortName", v)}
            error={errors.shortName}
            required
          />
          <TextField
            field="tagline"
            label="Lema"
            hint="Una frase que describa el municipio. Opcional."
            value={values.tagline}
            maxLength={PRESENTATION_LIMITS.tagline}
            onChange={(v) => set("tagline", v)}
            error={errors.tagline}
          />
        </fieldset>

        <fieldset disabled={!canEdit || pending}>
          <legend>Colores</legend>
          <div className="field" role="radiogroup" aria-labelledby="mode-label">
            <span id="mode-label">Fondo</span>
            <div className="choice-row">
              {(
                [
                  ["light", "Claro"],
                  ["dark", "Oscuro"],
                ] as const
              ).map(([mode, label]) => (
                <label key={mode} className="choice">
                  <input
                    type="radio"
                    name="mode"
                    value={mode}
                    checked={values.mode === mode}
                    onChange={() => set("mode", mode)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <ColorField
            field="brand"
            label="Color principal"
            hint="Botones, enlaces y textos destacados."
            value={values.brand}
            onChange={(v) => set("brand", v)}
            error={errors.brand}
          />
          <ColorField
            field="accent"
            label="Color de acento"
            hint="Detalles decorativos: líneas, mapa de la portada y marcos de foco."
            value={values.accent}
            onChange={(v) => set("accent", v)}
            error={errors.accent}
          />
        </fieldset>

        <fieldset disabled={!canEdit || pending}>
          <legend>Contacto</legend>
          <TextField
            field="email"
            label="Correo"
            type="email"
            value={values.email}
            maxLength={PRESENTATION_LIMITS.email}
            onChange={(v) => set("email", v)}
            error={errors.email}
          />
          <TextField
            field="phone"
            label="Teléfono"
            type="tel"
            value={values.phone}
            maxLength={PRESENTATION_LIMITS.phone}
            onChange={(v) => set("phone", v)}
            error={errors.phone}
          />
          <TextField
            field="address"
            label="Dirección"
            value={values.address}
            maxLength={PRESENTATION_LIMITS.address}
            onChange={(v) => set("address", v)}
            error={errors.address}
          />
        </fieldset>

        <fieldset disabled={!canEdit || pending}>
          <legend>Redes sociales</legend>
          {SOCIAL_NETWORKS.map((network) => (
            <TextField
              key={network}
              field={`social.${network}`}
              label={SOCIAL_LABELS[network]}
              type="url"
              placeholder="https://"
              value={values.social[network]}
              maxLength={PRESENTATION_LIMITS.url}
              onChange={(v) => setSocial(network, v)}
              error={errors[`social.${network}`]}
            />
          ))}
        </fieldset>

        <fieldset disabled={!canEdit || pending}>
          <legend>Buscadores</legend>
          <TextField
            field="description"
            label="Descripción"
            hint="El resumen que muestran Google y las redes al compartir el enlace (hasta 160 caracteres)."
            value={values.description}
            maxLength={PRESENTATION_LIMITS.description}
            onChange={(v) => set("description", v)}
            error={errors.description}
            multiline
          />
        </fieldset>

        {canEdit ? (
          <div className="form-actions branding-actions">
            <button
              type="submit"
              name="intent"
              value="publish"
              className="button"
              disabled={pending}
            >
              {pending ? "Guardando…" : "Publicar"}
            </button>
            <button
              type="submit"
              name="intent"
              value="save"
              className="button button-quiet"
              disabled={pending}
            >
              Guardar borrador
            </button>
          </div>
        ) : null}

        <p
          className={
            state.status === "saved" || state.status === "published" ? "form-success" : "form-error"
          }
          role="status"
          aria-live="polite"
        >
          {state.status === "idle" ? "" : STATUS_MESSAGES[state.status]}
          {state.status === "published" && state.version ? ` (versión ${state.version})` : ""}
        </p>
      </form>

      <BrandingPreview values={values} />
    </div>
  );
}

interface FieldProps {
  readonly field: BrandingField;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error?: string | undefined;
  readonly hint?: string;
}

function FieldShell({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      ) : null}
      {children}
      {error ? (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string) {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function TextField({
  field,
  label,
  value,
  onChange,
  error,
  hint,
  type = "text",
  maxLength,
  placeholder,
  required,
  multiline,
}: FieldProps & {
  readonly type?: "text" | "email" | "tel" | "url";
  readonly maxLength: number;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly multiline?: boolean;
}) {
  const id = useId();
  const common = {
    id,
    name: field,
    value,
    maxLength,
    required,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(id, hint, error),
  };
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      {multiline ? (
        <textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          {...common}
          type={type}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FieldShell>
  );
}

function ColorField({ field, label, value, onChange, error, hint }: FieldProps) {
  const id = useId();
  const normalized = value.trim().toLowerCase();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <div className="color-row">
        <input
          type="color"
          aria-label={`${label}: selector visual`}
          value={isHexColor(normalized) ? normalized : "#000000"}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          id={id}
          name={field}
          value={value}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </FieldShell>
  );
}
