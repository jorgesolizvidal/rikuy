"use client";

import { DESTINATION_LIMITS, suggestContentSlug } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import {
  createDestinationAction,
  type ContentKindName,
  type CreateDestinationState,
} from "./actions";

const WORDS = {
  destination: {
    one: "destino",
    many: "destinos",
    article: "un",
    example: "mirador-del-valle",
    path: "destinos",
  },
  event: {
    one: "evento",
    many: "eventos",
    article: "un",
    example: "feria-del-choclo",
    path: "agenda",
  },
} as const;

function messages(
  kind: ContentKindName,
): Partial<Record<CreateDestinationState["status"], string>> {
  const words = WORDS[kind];
  return {
    invalid_title: `Escribe el nombre del ${words.one} en una línea, hasta 120 caracteres.`,
    invalid_slug: `La dirección solo admite minúsculas, números y guiones, por ejemplo ${words.example}.`,
    slug_taken: `Ya existe ${words.article} ${words.one} con esa dirección. Elige otra.`,
    forbidden: `Tu rol no permite crear ${words.many}.`,
    signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
    error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
  };
}

export function NewDestinationForm({
  org,
  kind = "destination",
}: {
  readonly org: string;
  readonly kind?: ContentKindName;
}) {
  const words = WORDS[kind];
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
      router.push(`/o/${org}/${words.path}/${state.contentId}`);
    }
  }, [state, org, router, words.path]);

  const message = messages(kind)[state.status];
  const slugInvalid = state.status === "invalid_slug" || state.status === "slug_taken";

  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="kind" value={kind} />
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
          Forma parte del enlace del {words.one}. Se completa sola a partir del nombre.
        </span>
      </div>
      <button type="submit" className="button" disabled={pending || title.trim() === ""}>
        {pending ? "Creando…" : `Crear ${words.one}`}
      </button>
      {message ? (
        <span className="field-error" role="status">
          {message}
        </span>
      ) : null}
    </form>
  );
}
