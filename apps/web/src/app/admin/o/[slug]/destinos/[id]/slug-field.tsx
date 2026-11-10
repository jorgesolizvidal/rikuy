"use client";

import { DESTINATION_LIMITS, suggestContentSlug } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import { changeSlugAction, type ChangeSlugState, type ContentKindName } from "../actions";

/**
 * «Dirección en el portal» (ADR-047): the current address, the old ones that still lead
 * here, and, for owners and admins, changing it. Old links and printed QR codes keep
 * working; a place never published changes without leaving an old address.
 */

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeZone: "America/La_Paz",
});

export interface PreviousSlugEntry {
  readonly slug: string;
  readonly changedAt: string;
}

const WORDS = {
  destination: { section: "/destinos/", article: "otro destino", one: "este destino" },
  event: { section: "/agenda/", article: "otro evento", one: "este evento" },
} as const;

function message(state: ChangeSlugState, kind: ContentKindName): string | null {
  const words = WORDS[kind];
  switch (state.status) {
    case "invalid":
      return "La dirección solo admite minúsculas, números y guiones, por ejemplo museo-de-la-reforma.";
    case "unchanged":
      return "Es la misma dirección que ya tiene.";
    case "slug_taken":
      return `Ya la usa ${words.article}. Elige otra.`;
    case "slug_previous":
      return `La usaba antes ${words.article}: sus enlaces y códigos QR llevan ahí. Elige otra.`;
    case "stale":
      return "Alguien cambió la dirección mientras tanto. Recarga la página.";
    case "too_many":
      return "Ya tiene 20 direcciones anteriores, el máximo. Vuelve a una de ellas o deja la actual.";
    case "forbidden":
      return "Solo propietarios y administradores pueden cambiar la dirección.";
    case "not_found":
      return "No se encontró. Recarga la página.";
    case "signed_out":
      return "Tu sesión venció. Inicia sesión de nuevo.";
    case "error":
      return "No se pudo cambiar la dirección. Inténtalo de nuevo.";
    default:
      return null;
  }
}

export function SlugField({
  org,
  kind,
  contentId,
  slug,
  title,
  published,
  previous,
  canChange,
}: {
  readonly org: string;
  readonly kind: ContentKindName;
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  /** Ever published: changing keeps the old address leading here. */
  readonly published: boolean;
  readonly previous: readonly PreviousSlugEntry[];
  readonly canChange: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const words = WORDS[kind];
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(slug);
  const [state, action, pending] = useActionState(
    async (previousState: ChangeSlugState, formData: FormData) => {
      const next = await changeSlugAction(previousState, formData);
      if (next.status === "changed") {
        setOpen(false);
        // The editor keeps what is being typed; the page shows the new address and QR code.
        router.refresh();
      }
      return next;
    },
    { status: "idle" } satisfies ChangeSlugState,
  );
  const suggestion = suggestContentSlug(title);

  const error = message(state, kind);
  const invalid = state.status !== "idle" && state.status !== "changed" && error !== null;

  return (
    <section aria-labelledby={`${id}-heading`} className="slug-field">
      <h2 id={`${id}-heading`}>Dirección en el portal</h2>
      <p className="slug-current">
        <span className="cell-detail">{words.section}</span>
        <strong>{slug}</strong>
      </p>
      {state.status === "changed" && !open ? (
        <p className="notice" role="status">
          {state.previousSlug
            ? `Listo. La dirección anterior (${words.section}${state.previousSlug}) sigue llevando aquí: sus enlaces y códigos QR funcionan.`
            : "Listo. Como nunca se publicó, la dirección anterior no se guarda."}
        </p>
      ) : null}

      {previous.length > 0 ? (
        <div>
          <h3 className="slug-previous-heading">Direcciones anteriores</h3>
          <p className="field-hint">
            Siguen llevando aquí, así los enlaces compartidos y los códigos QR impresos funcionan.
            Ningún otro lugar puede usarlas.
          </p>
          <ul className="slug-previous">
            {previous.map((entry) => (
              <li key={entry.slug}>
                <span>
                  {words.section}
                  {entry.slug}
                </span>{" "}
                <span className="cell-detail">
                  · hasta el {DATE.format(new Date(entry.changedAt))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!canChange ? null : open ? (
        <form action={action} className="slug-form">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="contentId" value={contentId} />
          <input type="hidden" name="expectedSlug" value={slug} />
          <div className="field">
            <label htmlFor={`${id}-slug`}>Nueva dirección</label>
            <input
              id={`${id}-slug`}
              name="slug"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={DESTINATION_LIMITS.slug}
              autoComplete="off"
              spellCheck={false}
              required
              aria-describedby={`${id}-slug-hint${error ? ` ${id}-slug-error` : ""}`}
              aria-invalid={invalid ? true : undefined}
            />
            <span id={`${id}-slug-hint`} className="field-hint">
              Solo minúsculas, números y guiones.
              {published
                ? ` La dirección actual seguirá llevando a ${words.one}: los enlaces y códigos QR que ya circulan no se rompen. Para carteles nuevos, descarga el código QR nuevo.`
                : " Como todavía no se publicó, nadie tiene su enlace."}
            </span>
          </div>
          {suggestion !== "" && suggestion !== value ? (
            <p>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setValue(suggestion)}
              >
                Usar «{suggestion}» (a partir del nombre)
              </button>
            </p>
          ) : null}
          {error ? (
            <p id={`${id}-slug-error`} className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="inline-form">
            <button type="submit" className="button" disabled={pending}>
              {pending ? "Cambiando…" : "Cambiar la dirección"}
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                setOpen(false);
                setValue(slug);
              }}
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <p>
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              setValue(slug);
              setOpen(true);
            }}
          >
            Cambiar la dirección
          </button>
        </p>
      )}
    </section>
  );
}
