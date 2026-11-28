"use client";

import { FAQ_LIMITS } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { createFaqAction, type CreateFaqState } from "./actions";

const CREATE_MESSAGES: Partial<Record<CreateFaqState["status"], string>> = {
  invalid_title: "Escribe la pregunta en una línea, hasta 120 caracteres.",
  slug_taken: "Ya hay una pregunta igual. Ábrela en la lista o escríbela de otra forma.",
  forbidden: "Tu rol no permite crear preguntas.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
};

export function NewFaqForm({
  org,
  initialQuestion = "",
}: {
  readonly org: string;
  readonly initialQuestion?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [state, action, pending] = useActionState(createFaqAction, {
    status: "idle",
  } satisfies CreateFaqState);
  const [title, setTitle] = useState(initialQuestion);

  useEffect(() => {
    if (state.status === "created" && state.contentId) {
      router.push(`/o/${org}/preguntas-frecuentes/${state.contentId}`);
    }
  }, [state, org, router]);

  const message = CREATE_MESSAGES[state.status];
  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="org" value={org} />
      <div className="field">
        <label htmlFor={`${id}-title`}>Pregunta</label>
        <input
          id={`${id}-title`}
          name="title"
          value={title}
          maxLength={FAQ_LIMITS.question}
          required
          aria-describedby={`${id}-hint`}
          aria-invalid={state.status === "invalid_title" ? true : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
        <span id={`${id}-hint`} className="field-hint">
          Como la haría un visitante: «¿Hay cajero automático?» o «¿Cómo llego desde Cochabamba?».
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
