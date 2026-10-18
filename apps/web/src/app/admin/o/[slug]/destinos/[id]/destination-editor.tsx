"use client";

import { DESTINATION_LIMITS, parseMarkup, type DestinationIssue } from "@rikuy/core";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";

import { RichTextView } from "@/components/rich-text";

import {
  discardDraftAction,
  saveDestinationAction,
  type DestinationPayload,
  type RevisionActionState,
  type SaveDestinationState,
} from "../actions";
import { CoverField, GalleryField, type EditorImage } from "./image-fields";
import { LocationField } from "./location-field";

export interface EditorValues {
  readonly title: string;
  readonly summary: string;
  readonly markup: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly cover: EditorImage | null;
  readonly gallery: readonly EditorImage[];
}

interface DestinationEditorProps {
  readonly org: string;
  readonly contentId: string;
  readonly initial: EditorValues;
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  readonly hasPublished: boolean;
  readonly mapCenter: { readonly lat: number; readonly lng: number; readonly zoom: number };
}

const STATUS_MESSAGES: Partial<Record<SaveDestinationState["status"], string>> = {
  saved: "Borrador guardado. Los visitantes siguen viendo la versión publicada.",
  published: "Publicado. Los visitantes ya ven esta versión.",
  invalid: "Revisa los campos marcados.",
  conflict:
    "Otra persona cambió este destino mientras editabas, así que tus cambios no se guardaron. Copia lo que necesites y recarga la página.",
  forbidden: "Tu rol ya no permite este cambio.",
  not_found: "Este destino ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para guardar.",
  error: "No pudimos guardar. Inténtalo de nuevo en unos segundos.",
};

const FIELD_MESSAGES = {
  title: "Escribe el nombre en una línea, hasta 120 caracteres.",
  summaryInvalid: "El resumen admite una línea de hasta 300 caracteres.",
  summaryRequired: "Escribe un resumen: es lo primero que leen los visitantes.",
  body: "Revisa el texto: es demasiado largo o tiene un formato que no se admite.",
  locationRequired: "Marca la ubicación: los visitantes la necesitan para llegar.",
  location: "Revisa la ubicación.",
  images: "Una de las fotos ya no está disponible. Quítala y vuelve a subirla.",
  alt: "Escribe la descripción de cada foto.",
} as const;

function fieldErrors(issues: readonly DestinationIssue[] = []) {
  const errors: Partial<
    Record<"title" | "summary" | "body" | "location" | "images" | "coverAlt", string>
  > = {};
  const galleryAlts = new Set<number>();
  for (const issue of issues) {
    const [head, second, third] = issue.path.split(".");
    if (head === "title") errors.title = FIELD_MESSAGES.title;
    else if (head === "summary")
      errors.summary =
        issue.code === "required" ? FIELD_MESSAGES.summaryRequired : FIELD_MESSAGES.summaryInvalid;
    else if (head === "body") errors.body = FIELD_MESSAGES.body;
    else if (head === "location")
      errors.location =
        issue.code === "required" ? FIELD_MESSAGES.locationRequired : FIELD_MESSAGES.location;
    else if (head === "images") errors.images = FIELD_MESSAGES.images;
    else if (head === "cover") errors.coverAlt = FIELD_MESSAGES.alt;
    else if (head === "gallery" && third === "alt") galleryAlts.add(Number(second));
    else if (head === "gallery") errors.images = FIELD_MESSAGES.images;
  }
  return { errors, galleryAlts };
}

const toImage = (image: EditorImage) => ({
  assetId: image.assetId,
  version: image.version,
  alt: image.alt.trim(),
});

export function DestinationEditor({
  org,
  contentId,
  initial,
  editCount,
  canEdit,
  canPublish,
  hasPublished,
  mapCenter,
}: DestinationEditorProps) {
  const router = useRouter();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<EditorValues>(initial);
  // The action result also remembers what is stored, to tell unsaved changes apart.
  const [state, dispatch, pending] = useActionState(
    async (
      previous: SaveDestinationState & { readonly stored: string },
      submission: { readonly payload: DestinationPayload; readonly snapshot: string },
    ) => {
      // Only what the server needs: the stored snapshot (with signed preview URLs) stays here.
      const result = await saveDestinationAction(
        { status: previous.status, editCount: previous.editCount },
        submission.payload,
      );
      const ok = result.status === "saved" || result.status === "published";
      return { ...result, stored: ok ? submission.snapshot : previous.stored };
    },
    { status: "idle", editCount, stored: JSON.stringify(initial) },
  );
  const [discardState, discard, discarding] = useActionState(discardDraftAction, {
    status: "idle",
  } satisfies RevisionActionState);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [, startTransition] = useTransition();
  const parsed = useMemo(() => parseMarkup(values.markup), [values.markup]);
  const { errors, galleryAlts } = fieldErrors(state.issues);
  const dirty = JSON.stringify(values) !== state.stored;
  const locked = !canEdit || pending;

  const set = <K extends keyof EditorValues>(key: K, value: EditorValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  // After a successful save/publish: remember what is stored and refresh server data
  // (history, status). Discarding reloads the page so the form shows the published text.
  useEffect(() => {
    if (state.status === "saved" || state.status === "published") router.refresh();
    if (state.status === "invalid") {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [state, router]);
  useEffect(() => {
    if (discardState.status === "discarded") window.location.reload();
  }, [discardState]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const payload: DestinationPayload = {
      org,
      contentId,
      intent: submitter?.value === "publish" ? "publish" : "save",
      expectedEdit: state.editCount,
      title: values.title.trim(),
      summary: values.summary.trim(),
      markup: values.markup,
      location: values.location,
      cover: values.cover ? toImage(values.cover) : null,
      gallery: values.gallery.map(toImage),
    };
    startTransition(() => dispatch({ payload, snapshot: JSON.stringify(values) }));
  }

  const statusText =
    state.status === "idle"
      ? dirty
        ? "Tienes cambios sin guardar."
        : ""
      : `${STATUS_MESSAGES[state.status] ?? ""}${
          state.status === "published" && state.revisionNo ? ` (versión ${state.revisionNo})` : ""
        }`;

  return (
    <form ref={formRef} className="form destination-form" onSubmit={submit} noValidate>
      <fieldset disabled={locked}>
        <legend>Texto</legend>
        <div className="field">
          <label htmlFor={`${id}-title`}>Nombre</label>
          <input
            id={`${id}-title`}
            value={values.title}
            maxLength={DESTINATION_LIMITS.title}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? `${id}-title-error` : undefined}
            onChange={(event) => set("title", event.target.value)}
          />
          {errors.title ? (
            <span id={`${id}-title-error`} className="field-error">
              {errors.title}
            </span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={`${id}-summary`}>Resumen</label>
          <span id={`${id}-summary-hint`} className="field-hint">
            Una o dos frases: aparece en el listado, en Google y al compartir el enlace. Obligatorio
            para publicar.
          </span>
          <textarea
            id={`${id}-summary`}
            rows={2}
            value={values.summary}
            maxLength={DESTINATION_LIMITS.summary}
            aria-invalid={errors.summary ? true : undefined}
            aria-describedby={`${id}-summary-hint${errors.summary ? ` ${id}-summary-error` : ""}`}
            onChange={(event) => set("summary", event.target.value.replace(/\s*\n\s*/gu, " "))}
          />
          {errors.summary ? (
            <span id={`${id}-summary-error`} className="field-error">
              {errors.summary}
            </span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={`${id}-body`}>Descripción</label>
          <details className="format-help" id={`${id}-body-hint`}>
            <summary>Cómo dar formato al texto</summary>
            <ul>
              <li>Deja una línea en blanco entre párrafos.</li>
              <li>
                <code>## Título</code> y <code>### Subtítulo</code> al inicio de la línea.
              </li>
              <li>
                <code>- elemento</code> para listas; <code>1. elemento</code> para listas numeradas.
              </li>
              <li>
                <code>**negrita**</code>, <code>*cursiva*</code> y{" "}
                <code>[texto del enlace](https://…)</code>.
              </li>
            </ul>
          </details>
          <textarea
            id={`${id}-body`}
            className="markup-input"
            rows={14}
            value={values.markup}
            spellCheck
            aria-invalid={errors.body || parsed.problems.length > 0 ? true : undefined}
            aria-describedby={`${id}-body-hint ${id}-body-problems`}
            onChange={(event) => set("markup", event.target.value)}
          />
          <span id={`${id}-body-problems`} className="field-error" aria-live="polite">
            {parsed.problems.length > 0
              ? parsed.problems
                  .map(
                    (problem) =>
                      `Línea ${problem.line}: el enlace «${problem.detail}» debe empezar con https://.`,
                  )
                  .join(" ")
              : (errors.body ?? "")}
          </span>
        </div>
        <section className="markup-preview" aria-labelledby={`${id}-preview`}>
          <h2 id={`${id}-preview`} className="preview-label">
            Vista previa del texto
          </h2>
          {parsed.blocks.length > 0 ? (
            <div className="rich-text">
              <RichTextView blocks={parsed.blocks} headingOffset={1} />
            </div>
          ) : (
            <p className="field-hint">Escribe la descripción para verla aquí.</p>
          )}
        </section>
      </fieldset>

      <LocationField
        value={values.location}
        center={mapCenter}
        disabled={locked}
        error={errors.location}
        onChange={(point) => set("location", point)}
      />

      <CoverField
        org={org}
        value={values.cover}
        disabled={locked}
        altInvalid={Boolean(errors.coverAlt)}
        onChange={(cover) => set("cover", cover)}
      />
      <GalleryField
        org={org}
        value={values.gallery}
        disabled={locked}
        invalidAlts={galleryAlts}
        onChange={(gallery) => set("gallery", gallery)}
      />
      {errors.images || errors.coverAlt || galleryAlts.size > 0 ? (
        <p className="field-error">{errors.images ?? FIELD_MESSAGES.alt}</p>
      ) : null}

      {canEdit ? (
        <div className="form-actions branding-actions">
          {canPublish ? (
            <button
              type="submit"
              name="intent"
              value="publish"
              className="button"
              disabled={pending}
            >
              {pending ? "Guardando…" : "Publicar"}
            </button>
          ) : null}
          <button
            type="submit"
            name="intent"
            value="save"
            className={canPublish ? "button button-quiet" : "button"}
            disabled={pending}
          >
            Guardar borrador
          </button>
        </div>
      ) : null}
      {canEdit && !canPublish ? (
        <p className="field-hint">
          Un propietario o administrador del municipio revisará y publicará tus cambios.
        </p>
      ) : null}

      <p
        className={
          state.status === "saved" || state.status === "published" || state.status === "idle"
            ? "form-success"
            : "form-error"
        }
        role="status"
        aria-live="polite"
      >
        {statusText}
      </p>

      {canEdit && hasPublished && state.editCount !== null ? (
        <div className="discard-draft">
          {confirmDiscard ? (
            <>
              <button
                type="button"
                className="button button-danger"
                disabled={discarding}
                onClick={() => {
                  const data = new FormData();
                  data.set("org", org);
                  data.set("contentId", contentId);
                  data.set("expectedEdit", String(state.editCount));
                  startTransition(() => discard(data));
                }}
              >
                Confirmar: descartar el borrador
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setConfirmDiscard(false)}
              >
                Cancelar
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button button-quiet"
              onClick={() => setConfirmDiscard(true)}
            >
              Descartar borrador y volver a lo publicado
            </button>
          )}
          {discardState.status !== "idle" && discardState.status !== "discarded" ? (
            <span className="field-error" role="status">
              {discardState.status === "conflict"
                ? "El borrador cambió. Recarga la página."
                : "No se pudo descartar. Inténtalo de nuevo."}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
