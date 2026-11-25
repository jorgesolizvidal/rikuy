"use client";

import { SERVICE_LIMITS } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { createServiceAction, type CreateServiceState } from "./actions";

const CREATE_MESSAGES: Partial<Record<CreateServiceState["status"], string>> = {
  invalid_title: "Escribe el nombre en una línea, hasta 120 caracteres.",
  slug_taken: "Ya hay un servicio con ese nombre. Usa otro nombre.",
  forbidden: "Tu rol no permite crear servicios.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
};

export function NewServiceForm({ org }: { readonly org: string }) {
  const router = useRouter();
  const id = useId();
  const [state, action, pending] = useActionState(createServiceAction, {
    status: "idle",
  } satisfies CreateServiceState);
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (state.status === "created" && state.contentId) {
      router.push(`/o/${org}/servicios/${state.contentId}`);
    }
  }, [state, org, router]);

  const message = CREATE_MESSAGES[state.status];
  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="org" value={org} />
      <div className="field">
        <label htmlFor={`${id}-title`}>Nombre</label>
        <input
          id={`${id}-title`}
          name="title"
          value={title}
          maxLength={SERVICE_LIMITS.title}
          required
          aria-describedby={`${id}-hint`}
          aria-invalid={state.status === "invalid_title" ? true : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
        <span id={`${id}-hint`} className="field-hint">
          Por ejemplo, «Restaurante La Casona» o «Cajero de la plaza».
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
