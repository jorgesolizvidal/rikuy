"use client";

import { DESTINATION_LIMITS, suggestContentSlug } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { createDestinationAction, type CreateDestinationState } from "./actions";

const MESSAGES: Partial<Record<CreateDestinationState["status"], string>> = {
  invalid_title: "Escribe el nombre del destino en una línea, hasta 120 caracteres.",
  invalid_slug:
    "La dirección solo admite minúsculas, números y guiones, por ejemplo mirador-del-valle.",
  slug_taken: "Ya existe un destino con esa dirección. Elige otra.",
  forbidden: "Tu rol no permite crear destinos.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
};

export function NewDestinationForm({ org }: { readonly org: string }) {
  const router = useRouter();
  const id = useId();
  const [state, action, pending] = useActionState(createDestinationAction, {
    status: "idle",
  } satisfies CreateDestinationState);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  useEffect(() => {
    if (state.status === "created" && state.contentId) {
      router.push(`/o/${org}/destinos/${state.contentId}`);
    }
  }, [state, org, router]);

  const message = MESSAGES[state.status];
  const slugInvalid = state.status === "invalid_slug" || state.status === "slug_taken";

  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="org" value={org} />
      <div className="field">
        <label htmlFor={`${id}-title`}>Nombre</label>
        <input
          id={`${id}-title`}
          name="title"
          value={title}
          maxLength={DESTINATION_LIMITS.title}
          required
          aria-invalid={state.status === "invalid_title" ? true : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            if (!slugEdited) setSlug(suggestContentSlug(event.target.value));
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-slug`}>Dirección en el portal</label>
        <input
          id={`${id}-slug`}
          name="slug"
          value={slug}
          maxLength={DESTINATION_LIMITS.slug}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${id}-slug-hint`}
          aria-invalid={slugInvalid ? true : undefined}
          onChange={(event) => {
            setSlug(event.target.value);
            setSlugEdited(true);
          }}
        />
        <span id={`${id}-slug-hint`} className="field-hint">
          Forma parte del enlace del destino. Se completa sola a partir del nombre.
        </span>
      </div>
      <button type="submit" className="button" disabled={pending || title.trim() === ""}>
        {pending ? "Creando…" : "Crear destino"}
      </button>
      {message ? (
        <span className="field-error" role="status">
          {message}
        </span>
      ) : null}
    </form>
  );
}
