"use client";

import {
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_INFO,
  SERVICE_LIMITS,
  type ServiceCategory,
  type ServiceIssue,
} from "@rikuy/core";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";

import { HoursField, type HoursValues } from "../../destinos/[id]/hours-field";
import { fromHoursValues } from "../../destinos/[id]/hours-values";
import { LocationField } from "../../destinos/[id]/location-field";
import {
  discardServiceAction,
  retireServiceAction,
  saveServiceAction,
  type SaveServiceState,
  type ServiceActionState,
  type ServicePayload,
} from "../actions";

export interface ServiceValues {
  readonly title: string;
  readonly summary: string;
  readonly category: ServiceCategory;
  readonly hours: HoursValues;
  readonly phone: string;
  readonly whatsapp: string;
  readonly address: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
}

const STATUS_MESSAGES: Partial<Record<SaveServiceState["status"], string>> = {
  published: "Publicado. Ya se ve en la página «Servicios» del portal.",
  invalid: "Revisa los campos marcados.",
  conflict:
    "Otra persona cambió este servicio mientras editabas, así que tus cambios no se guardaron. Copia lo que necesites y recarga la página.",
  forbidden: "Tu rol ya no permite este cambio.",
  not_found: "Este servicio ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo para guardar.",
  error: "No pudimos guardar. Inténtalo de nuevo en unos segundos.",
};

type Field = "title" | "summary" | "category" | "hours" | "phone" | "whatsapp" | "address";

function fieldErrors(issues: readonly ServiceIssue[] = []) {
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of issues) {
    const [head] = issue.path.split(".");
    if (head === "title") errors.title = "Escribe el nombre en una línea, hasta 120 caracteres.";
    else if (head === "summary") {
      errors.summary = "La descripción admite una línea de hasta 300 caracteres.";
    } else if (head === "category") errors.category = "Elige una categoría de la lista.";
    else if (head === "hours") {
      errors.hours = "Revisa el horario: cada día, la hora de cierre va después de la de apertura.";
    } else if (head === "phone") {
      errors.phone = "Escribe solo el número: dígitos, espacios o guiones.";
    } else if (head === "whatsapp") {
      errors.whatsapp = "Escribe el número de WhatsApp con el código del país, por ejemplo +591.";
    } else if (head === "address") {
      errors.address =
        issue.code === "required"
          ? "Escribe la dirección o marca el lugar en el mapa: sin eso los visitantes no lo encuentran."
          : "La dirección admite una línea de hasta 160 caracteres.";
    } else if (head === "") {
      errors.title = "No se pudo guardar: revisa los campos y vuelve a intentarlo.";
    }
  }
  return errors;
}

const ACTION_MESSAGES: Partial<Record<ServiceActionState["status"], string>> = {
  conflict: "Cambió mientras tanto. Recarga la página.",
  forbidden: "Tu rol no permite este cambio.",
  not_found: "Este servicio ya no existe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo hacer. Inténtalo de nuevo.",
};

export function ServiceEditor({
  org,
  contentId,
  initial,
  mapCenter,
  editCount,
  canEdit,
  canPublish,
  published,
}: {
  readonly org: string;
  readonly contentId: string;
  readonly initial: ServiceValues;
  readonly mapCenter: { readonly lat: number; readonly lng: number; readonly zoom: number };
  readonly editCount: number | null;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  readonly published: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<ServiceValues>(initial);
  const [state, dispatch, pending] = useActionState(
    async (
      previous: SaveServiceState & { readonly stored: string },
      submission: { readonly payload: ServicePayload; readonly snapshot: string },
    ) => {
      const result = await saveServiceAction(
        { status: previous.status, editCount: previous.editCount },
        submission.payload,
      );
      const ok = result.status === "saved" || result.status === "published";
      return { ...result, stored: ok ? submission.snapshot : previous.stored };
    },
    { status: "idle", editCount, stored: JSON.stringify(initial) },
  );
  const [retireState, retire, retiring] = useActionState(retireServiceAction, {
    status: "idle",
  } satisfies ServiceActionState);
  const [discardState, discard, discarding] = useActionState(discardServiceAction, {
    status: "idle",
  } satisfies ServiceActionState);
  const [confirm, setConfirm] = useState<"retire" | "discard" | null>(null);
  const [, startTransition] = useTransition();
  const errors = fieldErrors(state.issues);
  const dirty = JSON.stringify(values) !== state.stored;
  const locked = !canEdit || pending;

  const set = <K extends keyof ServiceValues>(key: K, value: ServiceValues[K]) =>
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
    const payload: ServicePayload = {
      org,
      contentId,
      intent: submitter?.value === "publish" ? "publish" : "save",
      expectedEdit: state.editCount,
      title: values.title.trim(),
      summary: values.summary.trim(),
      category: values.category,
      hours: fromHoursValues(values.hours),
      phone: values.phone.trim(),
      whatsapp: values.whatsapp.trim(),
      address: values.address.trim(),
      location: values.location,
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
  const describedBy = (field: Field) =>
    [`${id}-${field}-hint`, errors[field] ? `${id}-${field}-error` : ""].filter(Boolean).join(" ");
  const error = (field: Field) =>
    errors[field] ? (
      <span id={`${id}-${field}-error`} className="field-error">
        {errors[field]}
      </span>
    ) : null;

  return (
    <form ref={formRef} className="form destination-form" onSubmit={submit} noValidate>
      <fieldset disabled={locked}>
        <legend>Servicio</legend>
        <div className="field">
          <label htmlFor={`${id}-title`}>Nombre</label>
          <span id={`${id}-title-hint`} className="field-hint">
            Como lo conoce la gente.
          </span>
          <input
            id={`${id}-title`}
            value={values.title}
            maxLength={SERVICE_LIMITS.title}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy("title")}
            onChange={(event) => set("title", event.target.value)}
          />
          {error("title")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-category`}>Categoría</label>
          <span id={`${id}-category-hint`} className="field-hint">
            Agrupa los servicios en el portal y ayuda al asistente a encontrarlo («¿hay un
            cajero?»).
          </span>
          <select
            id={`${id}-category`}
            value={values.category}
            aria-invalid={errors.category ? true : undefined}
            aria-describedby={describedBy("category")}
            onChange={(event) => set("category", event.target.value as ServiceCategory)}
          >
            {SERVICE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {SERVICE_CATEGORY_INFO[category].name}
              </option>
            ))}
          </select>
          {error("category")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-summary`}>Descripción corta</label>
          <span id={`${id}-summary-hint`} className="field-hint">
            Opcional: qué ofrece, en una línea. Por ejemplo, «Almuerzos y comida típica».
          </span>
          <textarea
            id={`${id}-summary`}
            rows={2}
            value={values.summary}
            maxLength={SERVICE_LIMITS.summary}
            aria-invalid={errors.summary ? true : undefined}
            aria-describedby={describedBy("summary")}
            onChange={(event) => set("summary", event.target.value.replace(/\s*\n\s*/gu, " "))}
          />
          {error("summary")}
        </div>
      </fieldset>

      <fieldset disabled={locked}>
        <legend>Cómo comunicarse</legend>
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-phone`}>Teléfono</label>
            <span id={`${id}-phone-hint`} className="field-hint">
              Opcional. En el portal se toca para llamar.
            </span>
            <input
              id={`${id}-phone`}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={values.phone}
              maxLength={24}
              aria-invalid={errors.phone ? true : undefined}
              aria-describedby={describedBy("phone")}
              onChange={(event) => set("phone", event.target.value)}
            />
            {error("phone")}
          </div>
          <div className="field">
            <label htmlFor={`${id}-whatsapp`}>WhatsApp</label>
            <span id={`${id}-whatsapp-hint`} className="field-hint">
              Opcional, con el código del país: +591…
            </span>
            <input
              id={`${id}-whatsapp`}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="+591"
              value={values.whatsapp}
              maxLength={24}
              aria-invalid={errors.whatsapp ? true : undefined}
              aria-describedby={describedBy("whatsapp")}
              onChange={(event) => set("whatsapp", event.target.value)}
            />
            {error("whatsapp")}
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${id}-address`}>Dirección</label>
          <span id={`${id}-address-hint`} className="field-hint">
            Como la explicarías a un visitante: «Calle Bolívar 12, frente a la plaza». Para publicar
            hace falta la dirección o el lugar en el mapa.
          </span>
          <input
            id={`${id}-address`}
            value={values.address}
            maxLength={SERVICE_LIMITS.address}
            aria-invalid={errors.address ? true : undefined}
            aria-describedby={describedBy("address")}
            onChange={(event) => set("address", event.target.value)}
          />
          {error("address")}
        </div>
      </fieldset>

      <HoursField
        value={values.hours}
        disabled={locked}
        error={errors.hours}
        onChange={(hours) => set("hours", hours)}
      />

      <LocationField
        value={values.location}
        center={mapCenter}
        disabled={locked}
        optional
        onChange={(point) => set("location", point)}
      />

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
          Un propietario o administrador del municipio revisará y publicará el servicio.
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
                Confirmar: retirar el servicio del portal y del asistente
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
                  Retirar (cerró o ya no atiende)
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
