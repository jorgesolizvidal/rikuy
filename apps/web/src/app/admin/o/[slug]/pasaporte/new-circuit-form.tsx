"use client";

import { suggestCircuitSlug } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { createCircuitAction, type CreateCircuitState } from "./actions";

const MESSAGES: Partial<Record<CreateCircuitState["status"], string>> = {
  taken: "Ya hay un circuito con esa dirección. Elige otra.",
  invalid: "Revisa el nombre y la dirección.",
  forbidden: "Tu rol no permite crear circuitos.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
};

/** «Nuevo circuito»: a name and its address in the portal, suggested from the name. */
export function NewCircuitForm({ org }: { readonly org: string }) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [state, action, pending] = useActionState(createCircuitAction, {
    status: "idle",
  } satisfies CreateCircuitState);

  useEffect(() => {
    if (state.status === "created") router.push(`/o/${org}/pasaporte/${state.circuitId}`);
  }, [state, org, router]);

  const errors = state.status === "invalid" ? (state.errors ?? {}) : {};
  const message = MESSAGES[state.status];

  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="org" value={org} />
      <div className="field">
        <label htmlFor={`${id}-name`}>Nombre del circuito</label>
        <input
          id={`${id}-name`}
          name="name"
          required
          maxLength={80}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!touched) setSlug(suggestCircuitSlug(event.target.value));
          }}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${id}-name-error` : undefined}
        />
        {errors.name ? (
          <p id={`${id}-name-error`} className="field-error">
            {errors.name}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`${id}-slug`}>Dirección en el portal</label>
        <input
          id={`${id}-slug`}
          name="slug"
          required
          maxLength={80}
          value={slug}
          onChange={(event) => {
            setTouched(true);
            setSlug(event.target.value);
          }}
          aria-invalid={errors.slug ? true : undefined}
          aria-describedby={`${id}-slug-hint`}
        />
        <p id={`${id}-slug-hint`} className={errors.slug ? "field-error" : "field-hint"}>
          {errors.slug ?? `Se verá como /pasaporte/${slug || "…"}`}
        </p>
      </div>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Creando…" : "Crear circuito"}
      </button>
      {message && state.status !== "invalid" ? (
        <p className="field-error" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}
