"use client";

import { NOTICE_LIMITS, parseMarkup, type NoticeIssue, type NoticePlaceOption } from "@rikuy/core";
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
  discardNoticeAction,
  retireNoticeAction,
  saveNoticeAction,
  type NoticeActionState,
  type NoticePayload,
  type SaveNoticeState,
} from "../actions";

/** The form's values; dates as `<input type="datetime-local">` gives them (local minutes). */
export interface NoticeValues {
  readonly title: string;
  readonly summary: string;
  readonly markup: string;
  readonly from: string;
  readonly until: string;
  readonly placeId: string;
}

const STATUS_MESSAGES: Partial<Record<SaveNoticeState["status"], string>> = {
  published: "Publicado. Se ve en el portal mientras esté vigente.",
  invalid: "Revisa los campos marcados.",
  conflict:
    "Otra persona cambió este aviso mientras editabas, así que tus cambios no se guardaron. Copia lo que necesites y recarga la página.",
  forbidden: "Tu rol ya no permite este cambio.",
  not_found: "Este aviso ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para guardar.",
  error: "No pudimos guardar. Inténtalo de nuevo en unos segundos.",
};

type Field = "title" | "summary" | "body" | "from" | "until" | "placeId";

function fieldErrors(issues: readonly NoticeIssue[] = []) {
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of issues) {
    const [head, key] = issue.path.split(".");
    if (head === "title") errors.title = "Escribe el título en una línea, hasta 120 caracteres.";
    else if (head === "summary") {
      errors.summary =
        issue.code === "required"
          ? "Escribe el texto del aviso: es lo que ven los visitantes en la franja."
          : "El texto del aviso admite una línea de hasta 300 caracteres.";
    } else if (head === "body") {
      errors.body = "Revisa el detalle: es demasiado largo o tiene un formato que no se admite.";
    } else if (head === "placeId") {
      errors.placeId = "Elige un destino o un evento de este municipio.";
    } else if (head === "validity") {
      const field = key === "from" ? "from" : "until";
      errors[field] =
        issue.code === "required"
          ? "Pon hasta cuándo vale el aviso: sin fecha de fin no se publica."
          : issue.code === "past"
            ? "Esa fecha ya pasó: el aviso no se vería. Pon una fecha que todavía no llegó."
            : issue.code === "too_long"
              ? "Un aviso dura como mucho 90 días desde que empieza. Si sigue después, publica otra versión con otra fecha."
              : issue.code === "order"
                ? "«Hasta» tiene que ser después de «Desde»."
                : "Revisa la fecha y la hora.";
    }
  }
  return errors;
}

const ACTION_MESSAGES: Partial<Record<NoticeActionState["status"], string>> = {
  conflict: "Cambió mientras tanto. Recarga la página.",
  never_published: "No hay una versión publicada a la cual volver.",
  forbidden: "Tu rol no permite este cambio.",
  not_found: "Este aviso ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo hacer. Inténtalo de nuevo.",
};

const KIND = { destination: "Destino", event: "Evento" } as const;

export function NoticeEditor({
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
  readonly initial: NoticeValues;
  readonly places: readonly NoticePlaceOption[];
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  /** A version is published (in force, programmed or ended). */
  readonly published: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<NoticeValues>(initial);
  const [state, dispatch, pending] = useActionState(
    async (
      previous: SaveNoticeState & { readonly stored: string },
      submission: { readonly payload: NoticePayload; readonly snapshot: string },
    ) => {
      const result = await saveNoticeAction(
        { status: previous.status, editCount: previous.editCount },
        submission.payload,
      );
      const ok = result.status === "saved" || result.status === "published";
      return { ...result, stored: ok ? submission.snapshot : previous.stored };
    },
    { status: "idle", editCount, stored: JSON.stringify(initial) },
  );
  const [retireState, retire, retiring] = useActionState(retireNoticeAction, {
    status: "idle",
  } satisfies NoticeActionState);
  const [discardState, discard, discarding] = useActionState(discardNoticeAction, {
    status: "idle",
  } satisfies NoticeActionState);
  const [confirm, setConfirm] = useState<"retire" | "discard" | null>(null);
  const [, startTransition] = useTransition();
  const parsed = useMemo(() => parseMarkup(values.markup), [values.markup]);
  const errors = fieldErrors(state.issues);
  const dirty = JSON.stringify(values) !== state.stored;
  const locked = !canEdit || pending;

  const set = <K extends keyof NoticeValues>(key: K, value: NoticeValues[K]) =>
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
    const payload: NoticePayload = {
      org,
      contentId,
      intent: submitter?.value === "publish" ? "publish" : "save",
      expectedEdit: state.editCount,
      title: values.title.trim(),
      summary: values.summary.trim(),
      markup: values.markup,
      from: values.from === "" ? null : values.from,
      until: values.until === "" ? null : values.until,
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
        <legend>Aviso</legend>
        <div className="field">
          <label htmlFor={`${id}-title`}>Título</label>
          <span id={`${id}-title-hint`} className="field-hint">
            Corto: lo primero que se lee en la franja.
          </span>
          <input
            id={`${id}-title`}
            value={values.title}
            maxLength={NOTICE_LIMITS.title}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy("title")}
            onChange={(event) => set("title", event.target.value)}
          />
          {error("title")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-summary`}>Texto del aviso</label>
          <span id={`${id}-summary-hint`} className="field-hint">
            Qué pasa y qué hacer, en una o dos frases. Obligatorio para publicar.
          </span>
          <textarea
            id={`${id}-summary`}
            rows={2}
            value={values.summary}
            maxLength={NOTICE_LIMITS.summary}
            aria-invalid={errors.summary ? true : undefined}
            aria-describedby={describedBy("summary")}
            onChange={(event) => set("summary", event.target.value.replace(/\s*\n\s*/gu, " "))}
          />
          {error("summary")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-body`}>Detalle</label>
          <span id={`${id}-body-hint`} className="field-hint">
            Opcional: desvíos, horarios, a quién llamar. Se ve en la página de avisos y el asistente
            también lo lee.
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
        <legend>Vigencia</legend>
        <p className="field-hint">
          En la hora del municipio. Al llegar «Hasta», el aviso deja de verse y el asistente deja de
          usarlo, sin que nadie tenga que retirarlo. Como mucho 90 días.
        </p>
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-from`}>Desde</label>
            <span id={`${id}-from-hint`} className="field-hint">
              Opcional: vacío, vale apenas se publica.
            </span>
            <input
              id={`${id}-from`}
              type="datetime-local"
              value={values.from}
              aria-invalid={errors.from ? true : undefined}
              aria-describedby={describedBy("from")}
              onChange={(event) => set("from", event.target.value.slice(0, 16))}
            />
            {error("from")}
          </div>
          <div className="field">
            <label htmlFor={`${id}-until`}>Hasta</label>
            <span id={`${id}-until-hint`} className="field-hint">
              Obligatorio para publicar.
            </span>
            <input
              id={`${id}-until`}
              type="datetime-local"
              value={values.until}
              aria-invalid={errors.until ? true : undefined}
              aria-describedby={describedBy("until")}
              onChange={(event) => set("until", event.target.value.slice(0, 16))}
            />
            {error("until")}
          </div>
        </div>
      </fieldset>

      <fieldset disabled={locked}>
        <legend>Lugar</legend>
        <div className="field">
          <label htmlFor={`${id}-placeId`}>¿Es sobre un lugar o un evento?</label>
          <span id={`${id}-placeId-hint`} className="field-hint">
            Opcional: el aviso también se ve en su página y el asistente lo dice cuando preguntan
            desde ahí.
          </span>
          <select
            id={`${id}-placeId`}
            value={values.placeId}
            aria-invalid={errors.placeId ? true : undefined}
            aria-describedby={describedBy("placeId")}
            onChange={(event) => set("placeId", event.target.value)}
          >
            <option value="">Ninguno: es para todo el municipio</option>
            {places.map((place) => (
              <option key={place.contentId} value={place.contentId}>
                {KIND[place.kind]} · {place.title}
              </option>
            ))}
          </select>
          {error("placeId")}
        </div>
      </fieldset>

      {values.summary.trim() !== "" ? (
        <section className="markup-preview" aria-labelledby={`${id}-preview`}>
          <h2 id={`${id}-preview`} className="preview-label">
            Vista previa de la franja
          </h2>
          <div className="notice-preview">
            <strong>{values.title.trim() || "Aviso"}</strong> {values.summary.trim()}
          </div>
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
          Un propietario o administrador del municipio revisará y publicará el aviso.
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
                Confirmar: retirar el aviso del portal y del asistente
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
                  Retirar ahora
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
