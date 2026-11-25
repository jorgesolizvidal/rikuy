"use client";

import { parseMarkup, STORY_LIMITS, type StoryIssue, type StoryPlaceOption } from "@rikuy/core";
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
  discardStoryAction,
  retireStoryAction,
  saveStoryAction,
  type SaveStoryState,
  type StoryActionState,
  type StoryPayload,
} from "../actions";

/** The form's values. */
export interface StoryValues {
  readonly title: string;
  readonly summary: string;
  readonly markup: string;
  readonly author: string;
  readonly anonymous: boolean;
  readonly community: string;
  readonly placeId: string;
  readonly consent: boolean;
}

const STATUS_MESSAGES: Partial<Record<SaveStoryState["status"], string>> = {
  published: "Publicado. Ya se ve en la página «Memoria» del portal.",
  invalid: "Revisa los campos marcados.",
  conflict:
    "Otra persona cambió este relato mientras editabas, así que tus cambios no se guardaron. Copia lo que necesites y recarga la página.",
  forbidden: "Tu rol ya no permite este cambio.",
  not_found: "Este relato ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para guardar.",
  error: "No pudimos guardar. Inténtalo de nuevo en unos segundos.",
};

type Field = "title" | "summary" | "body" | "author" | "community" | "placeId" | "consent";

function fieldErrors(issues: readonly StoryIssue[] = []) {
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of issues) {
    const [head] = issue.path.split(".");
    if (head === "title") errors.title = "Escribe el título en una línea, hasta 120 caracteres.";
    else if (head === "summary") {
      errors.summary = "El resumen admite una línea de hasta 300 caracteres.";
    } else if (head === "body") {
      errors.body =
        issue.code === "required"
          ? "Escribe el relato: sin texto no se publica."
          : "Revisa el texto: es demasiado largo o tiene un formato que no se admite.";
    } else if (head === "author") {
      errors.author =
        issue.code === "required"
          ? "Escribe quién lo cuenta, o marca «Prefiere que sea anónimo»."
          : "Escribe el nombre en una línea, hasta 80 caracteres.";
    } else if (head === "community") {
      errors.community = "Escríbelo en una línea, hasta 120 caracteres.";
    } else if (head === "placeId") {
      errors.placeId = "Elige un destino de este municipio.";
    } else if (head === "consent") {
      errors.consent =
        "Sin el permiso de la persona el relato no se publica. Confírmalo con ella y marca la casilla.";
    } else if (head === "") {
      errors.title = "No se pudo guardar: revisa los campos y vuelve a intentarlo.";
    }
  }
  return errors;
}

const ACTION_MESSAGES: Partial<Record<StoryActionState["status"], string>> = {
  conflict: "Cambió mientras tanto. Recarga la página.",
  never_published: "No hay una versión publicada a la cual volver.",
  forbidden: "Tu rol no permite este cambio.",
  not_found: "Este relato ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo hacer. Inténtalo de nuevo.",
};

export function StoryEditor({
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
  readonly initial: StoryValues;
  readonly places: readonly StoryPlaceOption[];
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  readonly published: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<StoryValues>(initial);
  const [state, dispatch, pending] = useActionState(
    async (
      previous: SaveStoryState & { readonly stored: string },
      submission: { readonly payload: StoryPayload; readonly snapshot: string },
    ) => {
      const result = await saveStoryAction(
        { status: previous.status, editCount: previous.editCount },
        submission.payload,
      );
      const ok = result.status === "saved" || result.status === "published";
      return { ...result, stored: ok ? submission.snapshot : previous.stored };
    },
    { status: "idle", editCount, stored: JSON.stringify(initial) },
  );
  const [retireState, retire, retiring] = useActionState(retireStoryAction, {
    status: "idle",
  } satisfies StoryActionState);
  const [discardState, discard, discarding] = useActionState(discardStoryAction, {
    status: "idle",
  } satisfies StoryActionState);
  const [confirm, setConfirm] = useState<"retire" | "discard" | null>(null);
  const [, startTransition] = useTransition();
  const parsed = useMemo(() => parseMarkup(values.markup), [values.markup]);
  const errors = fieldErrors(state.issues);
  const dirty = JSON.stringify(values) !== state.stored;
  const locked = !canEdit || pending;

  const set = <K extends keyof StoryValues>(key: K, value: StoryValues[K]) =>
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
    const payload: StoryPayload = {
      org,
      contentId,
      intent: submitter?.value === "publish" ? "publish" : "save",
      expectedEdit: state.editCount,
      title: values.title.trim(),
      summary: values.summary.trim(),
      markup: values.markup,
      author: values.anonymous ? "" : values.author.trim(),
      anonymous: values.anonymous,
      community: values.community.trim(),
      placeId: values.placeId === "" ? null : values.placeId,
      consent: values.consent,
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
        <legend>Relato</legend>
        <div className="field">
          <label htmlFor={`${id}-title`}>Título</label>
          <span id={`${id}-title-hint`} className="field-hint">
            Corto, como se lo conoce: «La noche de la helada».
          </span>
          <input
            id={`${id}-title`}
            value={values.title}
            maxLength={STORY_LIMITS.title}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy("title")}
            onChange={(event) => set("title", event.target.value)}
          />
          {error("title")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-summary`}>Resumen</label>
          <span id={`${id}-summary-hint`} className="field-hint">
            Opcional: de qué trata, en una línea. Se ve en la ficha de su lugar.
          </span>
          <textarea
            id={`${id}-summary`}
            rows={2}
            value={values.summary}
            maxLength={STORY_LIMITS.summary}
            aria-invalid={errors.summary ? true : undefined}
            aria-describedby={describedBy("summary")}
            onChange={(event) => set("summary", event.target.value.replace(/\s*\n\s*/gu, " "))}
          />
          {error("summary")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-body`}>El relato</label>
          <span id={`${id}-body-hint`} className="field-hint">
            Como lo contó la persona, con sus palabras. Obligatorio para publicar. Admite «##
            título», «- lista», **negrita** y *cursiva*.
          </span>
          <textarea
            id={`${id}-body`}
            className="markup-input"
            rows={10}
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
        <legend>Quién lo cuenta</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={values.anonymous}
            aria-describedby={`${id}-anonymous-hint`}
            onChange={(event) => set("anonymous", event.target.checked)}
          />
          Prefiere que sea anónimo
        </label>
        <p id={`${id}-anonymous-hint`} className="field-hint">
          El portal dirá «Anónimo» y su nombre no se guarda.
        </p>
        {values.anonymous ? null : (
          <div className="field">
            <label htmlFor={`${id}-author`}>Nombre</label>
            <span id={`${id}-author-hint`} className="field-hint">
              Como quiere que aparezca: «Doña Rosa Vargas». Obligatorio para publicar.
            </span>
            <input
              id={`${id}-author`}
              value={values.author}
              maxLength={STORY_LIMITS.author}
              autoComplete="off"
              aria-invalid={errors.author ? true : undefined}
              aria-describedby={describedBy("author")}
              onChange={(event) => set("author", event.target.value)}
            />
            {error("author")}
          </div>
        )}
        <div className="field">
          <label htmlFor={`${id}-community`}>Comunidad o relación con el lugar</label>
          <span id={`${id}-community-hint`} className="field-hint">
            Opcional: «Vecina de la plaza», «Comunidad Pucara», «Músico de la banda».
          </span>
          <input
            id={`${id}-community`}
            value={values.community}
            maxLength={STORY_LIMITS.community}
            aria-invalid={errors.community ? true : undefined}
            aria-describedby={describedBy("community")}
            onChange={(event) => set("community", event.target.value)}
          />
          {error("community")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-placeId`}>¿Sobre qué lugar?</label>
          <span id={`${id}-placeId-hint`} className="field-hint">
            Opcional: el relato también se ve en la ficha de ese destino.
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
                {place.title}
              </option>
            ))}
          </select>
          {error("placeId")}
        </div>
      </fieldset>

      <fieldset disabled={locked}>
        <legend>Permiso para publicar</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={values.consent}
            aria-invalid={errors.consent ? true : undefined}
            aria-describedby={`${id}-consent-hint${errors.consent ? ` ${id}-consent-error` : ""}`}
            onChange={(event) => set("consent", event.target.checked)}
          />
          La persona aceptó que se publique su relato
        </label>
        <p id={`${id}-consent-hint`} className="field-hint">
          Obligatorio para publicar. Queda guardado con cada versión publicada. Si la persona cambia
          de opinión, retira el relato.
        </p>
        {error("consent")}
      </fieldset>

      {parsed.blocks.length > 0 ? (
        <section className="markup-preview" aria-labelledby={`${id}-preview`}>
          <h2 id={`${id}-preview`} className="preview-label">
            Vista previa
          </h2>
          <p className="field-hint">
            {values.anonymous
              ? "Relato anónimo"
              : values.author.trim()
                ? `Relato de ${values.author.trim()}`
                : "Relato de…"}
            {values.community.trim() ? ` · ${values.community.trim()}` : ""}
          </p>
          <div className="rich-text">
            <RichTextView blocks={parsed.blocks} headingOffset={1} />
          </div>
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
          Un propietario o administrador del municipio revisará y publicará el relato.
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
                Confirmar: retirar el relato del portal y del asistente
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
                  Retirar (la persona lo pidió)
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
