"use client";

import { STORY_LIMITS } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { createStoryAction, type CreateStoryState } from "./actions";

const CREATE_MESSAGES: Partial<Record<CreateStoryState["status"], string>> = {
  invalid_title: "Escribe el título en una línea, hasta 120 caracteres.",
  slug_taken: "Ya hay un relato con ese título. Usa otro título.",
  forbidden: "Tu rol no permite crear relatos.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
};

export function NewStoryForm({ org }: { readonly org: string }) {
  const router = useRouter();
  const id = useId();
  const [state, action, pending] = useActionState(createStoryAction, {
    status: "idle",
  } satisfies CreateStoryState);
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (state.status === "created" && state.contentId) {
      router.push(`/o/${org}/memoria/${state.contentId}`);
    }
  }, [state, org, router]);

  const message = CREATE_MESSAGES[state.status];
  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="org" value={org} />
      <div className="field">
        <label htmlFor={`${id}-title`}>Título</label>
        <input
          id={`${id}-title`}
          name="title"
          value={title}
          maxLength={STORY_LIMITS.title}
          required
          aria-describedby={`${id}-hint`}
          aria-invalid={state.status === "invalid_title" ? true : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
        <span id={`${id}-hint`} className="field-hint">
          Por ejemplo, «La noche de la helada» o «Cómo se fundó el mercado».
        </span>
      </div>
      <button type="submit" className="button" disabled={pending || title.trim() === ""}>
        {pending ? "Creando…" : "Crear"}
      </button>
      {message ? (
        <span className="field-error" role="status">
          {message}
        </span>
      ) : null}
    </form>
  );
}
