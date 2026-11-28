"use client";

import {
  FAQ_LIMITS,
  FAQ_TOPIC_NAMES,
  FAQ_TOPICS,
  parseMarkup,
  type FaqIssue,
  type FaqPlaceOption,
  type FaqTopic,
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
  discardFaqAction,
  retireFaqAction,
  saveFaqAction,
  type SaveFaqState,
  type FaqActionState,
  type FaqPayload,
} from "../actions";

/** The form's values. */
export interface FaqValues {
  readonly title: string;
  readonly summary: string;
  readonly markup: string;
  readonly topic: FaqTopic;
  readonly placeId: string;
}

const STATUS_MESSAGES: Partial<Record<SaveFaqState["status"], string>> = {
  published: "Publicada. Ya se ve en la página «Preguntas frecuentes» del portal.",
  invalid: "Revisa los campos marcados.",
  conflict:
    "Otra persona cambió esta pregunta mientras editabas, así que tus cambios no se guardaron. Copia lo que necesites y recarga la página.",
  forbidden: "Tu rol ya no permite este cambio.",
  not_found: "Esta pregunta ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para guardar.",
  error: "No pudimos guardar. Inténtalo de nuevo en unos segundos.",
};

type Field = "title" | "summary" | "body" | "topic" | "placeId";

function fieldErrors(issues: readonly FaqIssue[] = []) {
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of issues) {
    const [head] = issue.path.split(".");
    if (head === "title") errors.title = "Escribe la pregunta en una línea, hasta 120 caracteres.";
    else if (head === "summary") {
      errors.summary =
        issue.code === "required"
          ? "Escribe la respuesta: sin ella no se publica."
          : "La respuesta admite una línea de hasta 300 caracteres.";
    } else if (head === "body") {
      errors.body = "Revisa el texto: es demasiado largo o tiene un formato que no se admite.";
    } else if (head === "topic") {
      errors.topic = "Elige un tema de la lista.";
    } else if (head === "placeId") {
      errors.placeId = "Elige un destino o evento de este municipio.";
    } else if (head === "") {
      errors.title = "No se pudo guardar: revisa los campos y vuelve a intentarlo.";
    }
  }
  return errors;
}

const ACTION_MESSAGES: Partial<Record<FaqActionState["status"], string>> = {
  conflict: "Cambió mientras tanto. Recarga la página.",
  never_published: "No hay una versión publicada a la cual volver.",
  forbidden: "Tu rol no permite este cambio.",
  not_found: "Esta pregunta ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo hacer. Inténtalo de nuevo.",
};

export function FaqEditor({
  org,
  contentId,
  initial,
  places,
  editCount,
  canEdit,
  canPublish,
  published,
}: {
  readonly org: string;
  readonly contentId: string;
  readonly initial: FaqValues;
  readonly places: readonly FaqPlaceOption[];
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  readonly published: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<FaqValues>(initial);
  const [state, dispatch, pending] = useActionState(
    async (
      previous: SaveFaqState & { readonly stored: string },
      submission: { readonly payload: FaqPayload; readonly snapshot: string },
    ) => {
      const result = await saveFaqAction(
        { status: previous.status, editCount: previous.editCount },
        submission.payload,
      );
      const ok = result.status === "saved" || result.status === "published";
      return { ...result, stored: ok ? submission.snapshot : previous.stored };
    },
    { status: "idle", editCount, stored: JSON.stringify(initial) },
  );
  const [retireState, retire, retiring] = useActionState(retireFaqAction, {
    status: "idle",
  } satisfies FaqActionState);
  const [discardState, discard, discarding] = useActionState(discardFaqAction, {
    status: "idle",
  } satisfies FaqActionState);
  const [confirm, setConfirm] = useState<"retire" | "discard" | null>(null);
  const [, startTransition] = useTransition();
  const parsed = useMemo(() => parseMarkup(values.markup), [values.markup]);
  const errors = fieldErrors(state.issues);
  const dirty = JSON.stringify(values) !== state.stored;
  const locked = !canEdit || pending;

  const set = <K extends keyof FaqValues>(key: K, value: FaqValues[K]) =>
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
    const payload: FaqPayload = {
      org,
      contentId,
      intent: submitter?.value === "publish" ? "publish" : "save",
      expectedEdit: state.editCount,
      title: values.title.trim(),
      summary: values.summary.trim(),
      markup: values.markup,
      topic: values.topic,
      placeId: values.placeId === "" ? null : values.placeId,
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
    ? "Borrador guardado. El portal sigue mostrando la versión publicada."
    : "Borrador guardado. Se verá cuando se publique.";
  const statusText =
    state.status === "idle"
      ? dirty
        ? "Tienes cambios sin guardar."
        : ""
      : `${state.status === "saved" ? savedText : (STATUS_MESSAGES[state.status] ?? "")}${
          state.status === "published" && state.revisionNo ? ` (versión ${state.revisionNo})` : ""
        }`;
  const actionMessage = ACTION_MESSAGES[retireState.status] ?? ACTION_MESSAGES[discardState.status];
  const describedBy = (field: Field, hint = true) =>
    [hint ? `${id}-${field}-hint` : "", errors[field] ? `${id}-${field}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const error = (field: Field) =>
    errors[field] ? (
      <span id={`${id}-${field}-error`} className="field-error">
        {errors[field]}
      </span>
    ) : null;

  return (
    <form ref={formRef} className="form destination-form" onSubmit={submit} noValidate>
      <fieldset disabled={locked}>
        <legend>Pregunta y respuesta</legend>
        <div className="field">
          <label htmlFor={`${id}-title`}>Pregunta</label>
          <span id={`${id}-title-hint`} className="field-hint">
            Como la haría un visitante: «¿Hay cajero automático?».
          </span>
          <input
            id={`${id}-title`}
            value={values.title}
            maxLength={FAQ_LIMITS.question}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy("title")}
            onChange={(event) => set("title", event.target.value)}
          />
          {error("title")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-summary`}>Respuesta</label>
          <span id={`${id}-summary-hint`} className="field-hint">
            En una o dos oraciones: es lo que leen primero los visitantes y los buscadores.
            Obligatoria para publicar.
          </span>
          <textarea
            id={`${id}-summary`}
            rows={3}
            value={values.summary}
            maxLength={FAQ_LIMITS.answer}
            aria-invalid={errors.summary ? true : undefined}
            aria-describedby={describedBy("summary")}
            onChange={(event) => set("summary", event.target.value.replace(/\s*\n\s*/gu, " "))}
          />
          {error("summary")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-body`}>Más detalles</label>
          <span id={`${id}-body-hint`} className="field-hint">
            Opcional. Admite «## título», «- lista», **negrita**, *cursiva* y enlaces
            [texto](https://…).
          </span>
          <textarea
            id={`${id}-body`}
            className="markup-input"
            rows={6}
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
      </fieldset>

      <fieldset disabled={locked}>
        <legend>Dónde se ve</legend>
        <div className="field">
          <label htmlFor={`${id}-topic`}>Tema</label>
          <span id={`${id}-topic-hint`} className="field-hint">
            La página «Preguntas frecuentes» las agrupa por tema.
          </span>
          <select
            id={`${id}-topic`}
            value={values.topic}
            aria-invalid={errors.topic ? true : undefined}
            aria-describedby={describedBy("topic")}
            onChange={(event) => set("topic", event.target.value as FaqTopic)}
          >
            {FAQ_TOPICS.map((topic) => (
              <option key={topic} value={topic}>
                {FAQ_TOPIC_NAMES[topic]}
              </option>
            ))}
          </select>
          {error("topic")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-placeId`}>¿Sobre qué lugar?</label>
          <span id={`${id}-placeId-hint`} className="field-hint">
            Opcional: la pregunta también se ve en la ficha de ese destino o evento.
          </span>
          <select
            id={`${id}-placeId`}
            value={values.placeId}
            aria-invalid={errors.placeId ? true : undefined}
            aria-describedby={describedBy("placeId")}
            onChange={(event) => set("placeId", event.target.value)}
          >
            <option value="">Ninguno: es del municipio</option>
            {places.map((place) => (
              <option key={place.contentId} value={place.contentId}>
                {place.kind === "event" ? `Evento: ${place.title}` : place.title}
              </option>
            ))}
          </select>
          {error("placeId")}
        </div>
      </fieldset>

      {values.summary.trim() !== "" ? (
        <section className="markup-preview" aria-labelledby={`${id}-preview`}>
          <h2 id={`${id}-preview`} className="preview-label">
            Vista previa
          </h2>
          <p>
            <strong>{values.title.trim()}</strong>
          </p>
          <p>{values.summary.trim()}</p>
          {parsed.blocks.length > 0 ? (
            <div className="rich-text">
              <RichTextView blocks={parsed.blocks} headingOffset={1} />
            </div>
          ) : null}
        </section>
      ) : null}

      {canEdit ? (
        <div className="form-actions branding-actions sticky-actions">
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
          Un propietario o administrador del municipio revisará y publicará la pregunta.
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
                key="confirm-retire"
                type="button"
                className="button button-danger"
                disabled={retiring}
                onClick={() => act(retire)}
              >
                Confirmar: retirar la pregunta del portal y del asistente
              </button>
              <button
                key="cancel-retire"
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
                key="confirm-discard"
                type="button"
                className="button button-danger"
                disabled={discarding}
                onClick={() => act(discard, { expectedEdit: String(state.editCount) })}
              >
                Confirmar: descartar el borrador
              </button>
              <button
                key="cancel-discard"
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
                  key="retire"
                  type="button"
                  className="button button-quiet"
                  onClick={() => setConfirm("retire")}
                >
                  Retirar (ya no aplica)
                </button>
              ) : null}
              {published && state.editCount !== null ? (
                <button
                  key="discard"
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
