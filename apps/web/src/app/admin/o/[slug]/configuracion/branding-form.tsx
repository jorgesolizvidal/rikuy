"use client";

import {
  isHexColor,
  NEARBY_RADIUS,
  PRESENTATION_LIMITS,
  SOCIAL_NETWORKS,
  styleAllowsMode,
  THEME_DEFINITIONS,
  THEME_STYLES,
  type SocialNetwork,
  type ThemeStyle,
} from "@rikuy/core";
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
import { LogoField, type LogoSelection } from "./logo-field";

interface BrandingFormProps {
  readonly slug: string;
  readonly initial: BrandingValues;
  readonly revision: number | null;
  readonly canEdit: boolean;
  /** Signed preview of the logo the editor starts with (draft or published), if any. */
  readonly logoPreviewUrl: string | null;
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

export function BrandingForm({
  slug,
  initial,
  revision,
  canEdit,
  logoPreviewUrl,
}: BrandingFormProps) {
  const [values, setValues] = useState(initial);
  const [logoPreview, setLogoPreview] = useState(logoPreviewUrl);
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
  // A theme that has only a dark background takes it at once (ADR-061).
  const setStyle = (style: ThemeStyle) =>
    setValues((current) => ({
      ...current,
      style,
      mode: styleAllowsMode(style, current.mode) ? current.mode : "dark",
    }));
  const setSocial = (network: SocialNetwork, url: string) =>
    setValues((current) => ({ ...current, social: { ...current.social, [network]: url } }));
  const setLogo = (logo: LogoSelection | null) => {
    setValues((current) => ({
      ...current,
      logoAssetId: logo?.assetId ?? "",
      logoVersion: logo?.version ?? "",
    }));
    setLogoPreview(logo?.previewUrl ?? null);
  };
  const hasLogo = values.logoAssetId !== "";

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
        <input type="hidden" name="logo.assetId" value={values.logoAssetId} />
        <input type="hidden" name="logo.version" value={values.logoVersion} />

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
          <LogoField
            slug={slug}
            disabled={!canEdit || pending}
            hasLogo={hasLogo}
            previewUrl={logoPreview}
            error={errors.logo}
            onChange={setLogo}
          />
        </fieldset>

        <fieldset disabled={!canEdit || pending}>
          <legend>Tema del portal</legend>
          <p className="field-hint" id="style-hint">
            El tema decide las letras, la forma de las tarjetas y de los botones. Los colores y el
            logo siguen siendo los del municipio.
          </p>
          <div
            className="field"
            role="radiogroup"
            aria-labelledby="style-label"
            aria-describedby={errors.style ? "style-error" : "style-hint"}
            aria-invalid={errors.style ? true : undefined}
            tabIndex={errors.style ? -1 : undefined}
          >
            <span id="style-label" className="visually-hidden">
              Tema
            </span>
            <div className="theme-choices">
              {THEME_STYLES.map((style) => (
                <label key={style} className="theme-choice">
                  <input
                    type="radio"
                    name="style"
                    value={style}
                    checked={values.style === style}
                    onChange={() => setStyle(style)}
                    aria-describedby={`style-${style}-text`}
                  />
                  <span className="theme-choice-name">{THEME_DEFINITIONS[style].name}</span>
                  <span className="theme-choice-text" id={`style-${style}-text`}>
                    {THEME_DEFINITIONS[style].description}
                  </span>
                </label>
              ))}
            </div>
            {errors.style ? (
              <span className="field-error" id="style-error">
                {errors.style}
              </span>
            ) : null}
          </div>
        </fieldset>

        <fieldset disabled={!canEdit || pending}>
          <legend>Colores</legend>
          <div
            className="field"
            role="radiogroup"
            aria-labelledby="mode-label"
            aria-describedby={errors.mode ? "mode-error" : undefined}
            aria-invalid={errors.mode ? true : undefined}
            tabIndex={errors.mode ? -1 : undefined}
          >
            <span id="mode-label">Fondo</span>
            <div className="choice-row">
              {(
                [
                  ["light", "Claro"],
                  ["dark", "Oscuro"],
                ] as const
              ).map(([mode, label]) => {
                const allowed = styleAllowsMode(values.style, mode);
                return (
                  <label key={mode} className="choice">
                    <input
                      type="radio"
                      name="mode"
                      value={mode}
                      checked={values.mode === mode}
                      disabled={!allowed}
                      onChange={() => set("mode", mode)}
                    />
                    {label}
                    {allowed ? null : (
                      <span className="choice-note">
                        {" "}
                        (el tema {THEME_DEFINITIONS[values.style].name} es oscuro)
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            {errors.mode ? (
              <span className="field-error" id="mode-error">
                {errors.mode}
              </span>
            ) : null}
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

        <fieldset disabled={!canEdit || pending}>
          <legend>Visitantes</legend>
          <TextField
            field="nearbyRadius"
            label="Aviso «Estás cerca de…» (metros)"
            hint={`Cuando un visitante con la ubicación activada llega a esta distancia de un destino, el portal se lo avisa. Entre ${NEARBY_RADIUS.min} y ${NEARBY_RADIUS.max}; vacío usa ${NEARBY_RADIUS.default} m.`}
            value={values.nearbyRadius}
            maxLength={4}
            placeholder={String(NEARBY_RADIUS.default)}
            inputMode="numeric"
            onChange={(v) => set("nearbyRadius", v)}
            error={errors.nearbyRadius}
          />
        </fieldset>

        <fieldset disabled={!canEdit || pending}>
          <legend>Asistente del portal</legend>
          <p className="field-hint">
            El asistente responde las preguntas de los visitantes con lo que publicaste. Se abre con
            un botón en todas las páginas del portal.
          </p>
          <TextField
            field="assistantName"
            label="Nombre del asistente"
            hint="Aparece en el botón y en la conversación. Vacío: «Asistente»."
            value={values.assistantName}
            maxLength={PRESENTATION_LIMITS.assistantName}
            onChange={(v) => set("assistantName", v)}
            error={errors.assistantName}
          />
          <TextField
            field="assistantGreeting"
            label="Saludo"
            hint="Lo primero que lee el visitante al abrirlo, en una línea. Vacío: un saludo con el nombre del asistente y del portal."
            value={values.assistantGreeting}
            maxLength={PRESENTATION_LIMITS.assistantGreeting}
            onChange={(v) => set("assistantGreeting", v)}
            error={errors.assistantGreeting}
            multiline
          />
          <div className="field" role="radiogroup" aria-labelledby="tone-label">
            <span id="tone-label">Tono</span>
            <div className="choice-row">
              {(
                [
                  ["warm", "Cercano"],
                  ["formal", "Formal"],
                ] as const
              ).map(([tone, label]) => (
                <label key={tone} className="choice">
                  <input
                    type="radio"
                    name="assistantTone"
                    value={tone}
                    checked={values.assistantTone === tone}
                    onChange={() => set("assistantTone", tone)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <span className="field-hint">
              Cercano: tutea y saluda con calidez. Formal: trata de «usted» y va al punto.
            </span>
            {errors.assistantTone ? (
              <span className="field-error">{errors.assistantTone}</span>
            ) : null}
          </div>
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

      <BrandingPreview values={values} logoUrl={hasLogo ? logoPreview : null} />
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
  inputMode,
}: FieldProps & {
  readonly type?: "text" | "email" | "tel" | "url";
  readonly inputMode?: "numeric";
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
          inputMode={inputMode}
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
