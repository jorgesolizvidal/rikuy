"use client";

import {
  KNOWLEDGE_LIMITS,
  parseMarkup,
  type DestinationIssue,
  type DocumentVersionView,
} from "@rikuy/core";
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
  discardKnowledgeAction,
  retireKnowledgeAction,
  saveKnowledgeAction,
  type KnowledgeActionState,
  type KnowledgePayload,
  type SaveKnowledgeState,
} from "../actions";
import { DocumentField, type DocumentValue } from "./document-field";

export interface KnowledgeValues {
  readonly title: string;
  readonly summary: string;
  readonly markup: string;
  readonly document: DocumentValue;
}

const STATUS_MESSAGES: Partial<Record<SaveKnowledgeState["status"], string>> = {
  saved: "Borrador guardado. El asistente sigue usando la versión publicada.",
  published: "Publicado. El asistente lo leerá en unos segundos.",
  invalid: "Revisa los campos marcados.",
  conflict:
    "Otra persona cambió este conocimiento mientras editabas, así que tus cambios no se guardaron. Copia lo que necesites y recarga la página.",
  forbidden: "Tu rol ya no permite este cambio.",
  not_found: "Este conocimiento ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para guardar.",
  error: "No pudimos guardar. Inténtalo de nuevo en unos segundos.",
};

function fieldErrors(issues: readonly DestinationIssue[] = []) {
  const errors: Partial<Record<"title" | "summary" | "body" | "document", string>> = {};
  for (const issue of issues) {
    const head = issue.path.split(".")[0];
    if (head === "title") errors.title = "Escribe el nombre en una línea, hasta 120 caracteres.";
    else if (head === "summary")
      errors.summary = "El resumen admite una línea de hasta 300 caracteres.";
    else if (head === "body") {
      errors.body =
        issue.code === "required"
          ? "Escribe un texto o sube un documento: el asistente necesita algo que leer."
          : "Revisa el texto: es demasiado largo o tiene un formato que no se admite.";
    } else if (head === "document") {
      errors.document =
        issue.code === "media"
          ? "El documento todavía se está leyendo (o no se pudo leer). Espera a que diga «leído» para publicar."
          : "Ese documento ya no está disponible. Quítalo y vuelve a subirlo.";
    }
  }
  return errors;
}

const ACTION_MESSAGES: Partial<Record<KnowledgeActionState["status"], string>> = {
  conflict: "Cambió mientras tanto. Recarga la página.",
  never_published: "No hay una versión publicada a la cual volver.",
  forbidden: "Tu rol no permite este cambio.",
  not_found: "Este conocimiento ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo hacer. Inténtalo de nuevo.",
};

export function KnowledgeEditor({
  org,
  contentId,
  initial,
  initialDocument,
  editCount,
  canEdit,
  canPublish,
  published,
}: {
  readonly org: string;
  readonly contentId: string;
  readonly initial: KnowledgeValues;
  readonly initialDocument: DocumentVersionView | null;
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  /** The assistant uses a published version now. */
  readonly published: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<KnowledgeValues>(initial);
  const [state, dispatch, pending] = useActionState(
    async (
      previous: SaveKnowledgeState & { readonly stored: string },
      submission: { readonly payload: KnowledgePayload; readonly snapshot: string },
    ) => {
      const result = await saveKnowledgeAction(
        { status: previous.status, editCount: previous.editCount },
        submission.payload,
      );
      const ok = result.status === "saved" || result.status === "published";
      return { ...result, stored: ok ? submission.snapshot : previous.stored };
    },
    { status: "idle", editCount, stored: JSON.stringify(initial) },
  );
  const [retireState, retire, retiring] = useActionState(retireKnowledgeAction, {
    status: "idle",
  } satisfies KnowledgeActionState);
  const [discardState, discard, discarding] = useActionState(discardKnowledgeAction, {
    status: "idle",
  } satisfies KnowledgeActionState);
  const [confirm, setConfirm] = useState<"retire" | "discard" | null>(null);
  const [, startTransition] = useTransition();
  const parsed = useMemo(() => parseMarkup(values.markup), [values.markup]);
  const errors = fieldErrors(state.issues);
  const dirty = JSON.stringify(values) !== state.stored;
  const locked = !canEdit || pending;

  const set = <K extends keyof KnowledgeValues>(key: K, value: KnowledgeValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (state.status === "saved" || state.status === "published") router.refresh();
    if (state.status === "invalid") {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [state, router]);
  useEffect(() => {
    if (retireState.status === "retired" || discardState.status === "discarded") {
      window.location.reload();
    }
  }, [retireState, discardState]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const payload: KnowledgePayload = {
      org,
      contentId,
      intent: submitter?.value === "publish" ? "publish" : "save",
      expectedEdit: state.editCount,
      title: values.title.trim(),
      summary: values.summary.trim(),
      markup: values.markup,
      document: values.document,
    };
    startTransition(() => dispatch({ payload, snapshot: JSON.stringify(values) }));
  }

  const act = (action: (data: FormData) => void, extra: Record<string, string> = {}) => {
    const data = new FormData();
    data.set("org", org);
    data.set("contentId", contentId);
    for (const [key, value] of Object.entries(extra)) data.set(key, value);
    startTransition(() => action(data));
  };

  const savedText = published
    ? "Borrador guardado. El asistente sigue usando la versión publicada."
    : "Borrador guardado. El asistente lo usará cuando se publique.";
  const statusText =
    state.status === "idle"
      ? dirty
        ? "Tienes cambios sin guardar."
        : ""
      : `${state.status === "saved" ? savedText : (STATUS_MESSAGES[state.status] ?? "")}${
          state.status === "published" && state.revisionNo ? ` (versión ${state.revisionNo})` : ""
        }`;
  const actionMessage = ACTION_MESSAGES[retireState.status] ?? ACTION_MESSAGES[discardState.status];

  return (
    <form ref={formRef} className="form destination-form" onSubmit={submit} noValidate>
      <fieldset disabled={locked}>
        <legend>Texto</legend>
        <div className="field">
          <label htmlFor={`${id}-title`}>Nombre</label>
          <span id={`${id}-title-hint`} className="field-hint">
            Aparece en las citas del asistente.
          </span>
          <input
            id={`${id}-title`}
            value={values.title}
            maxLength={KNOWLEDGE_LIMITS.title}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={`${id}-title-hint${errors.title ? ` ${id}-title-error` : ""}`}
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
            Opcional: de qué trata, en una o dos frases.
          </span>
          <textarea
            id={`${id}-summary`}
            rows={2}
            value={values.summary}
            maxLength={KNOWLEDGE_LIMITS.summary}
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
          <label htmlFor={`${id}-body`}>Texto</label>
          <details className="format-help" id={`${id}-body-hint`}>
            <summary>Qué escribir y cómo darle formato</summary>
            <ul>
              <li>
                Datos que el asistente debe conocer: historia, horarios, servicios, preguntas
                frecuentes. Si tienes un libro o un informe, súbelo abajo como documento.
              </li>
              <li>Deja una línea en blanco entre párrafos.</li>
              <li>
                <code>## Título</code> y <code>### Subtítulo</code> al inicio de la línea: el
                asistente cita la sección.
              </li>
              <li>
                <code>- elemento</code> para listas; <code>**negrita**</code> y{" "}
                <code>*cursiva*</code>.
              </li>
            </ul>
          </details>
          <textarea
            id={`${id}-body`}
            className="markup-input"
            rows={12}
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
        {parsed.blocks.length > 0 ? (
          <section className="markup-preview" aria-labelledby={`${id}-preview`}>
            <h2 id={`${id}-preview`} className="preview-label">
              Vista previa del texto
            </h2>
            <div className="rich-text">
              <RichTextView blocks={parsed.blocks} headingOffset={1} />
            </div>
          </section>
        ) : null}
      </fieldset>

      <DocumentField
        org={org}
        value={values.document}
        initialView={initialDocument}
        disabled={locked}
        error={errors.document}
        onChange={(document) => set("document", document)}
      />

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

      {canEdit && (published || state.editCount !== null) ? (
        <div className="discard-draft">
          {confirm === "retire" ? (
            <>
              <button
                type="button"
                className="button button-danger"
                disabled={retiring}
                onClick={() => act(retire)}
              >
                Confirmar: el asistente deja de usarlo
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setConfirm(null)}
              >
                Cancelar
              </button>
            </>
          ) : confirm === "discard" ? (
            <>
              <button
                type="button"
                className="button button-danger"
                disabled={discarding}
                onClick={() => act(discard, { expectedEdit: String(state.editCount) })}
              >
                Confirmar: descartar el borrador
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setConfirm(null)}
              >
                Cancelar
              </button>
            </>
          ) : (
            <>
              {published && canPublish ? (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setConfirm("retire")}
                >
                  Retirar
                </button>
              ) : null}
              {published && state.editCount !== null ? (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setConfirm("discard")}
                >
                  Descartar borrador y volver a lo publicado
                </button>
              ) : null}
            </>
          )}
          {actionMessage ? (
            <span className="field-error" role="status">
              {actionMessage}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
