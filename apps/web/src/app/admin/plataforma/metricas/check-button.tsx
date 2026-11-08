"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { checkPublicationAction, type CheckState } from "./actions";

const MESSAGES: Readonly<Record<CheckState["status"], string>> = {
  idle: "",
  checked: "Revisado: el resultado de arriba es el de ahora.",
  not_found: "No encontramos ese municipio.",
  forbidden: "Hace falta la verificación en dos pasos de operador.",
  error: "No pudimos revisarlo. Inténtalo de nuevo.",
};

/** «Revisar ahora» (ADR-044): runs the integrity check for one municipality. */
export function CheckPublicationButton({ tenantId }: { readonly tenantId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(checkPublicationAction, {
    status: "idle",
  } as CheckState);
  useEffect(() => {
    if (state.status === "checked") router.refresh();
  }, [state, router]);

  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="tenantId" value={tenantId} />
      <button type="submit" className="button button-quiet" disabled={pending}>
        {pending ? "Revisando…" : "Revisar ahora"}
      </button>
      <span
        className={
          state.status === "checked" || state.status === "idle" ? "field-hint" : "field-error"
        }
        role="status"
      >
        {MESSAGES[state.status]}
      </span>
    </form>
  );
}
