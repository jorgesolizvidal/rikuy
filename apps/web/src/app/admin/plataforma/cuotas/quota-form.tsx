"use client";

import type { UsageResource } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId } from "react";

import { changeQuotaAction, type QuotaState } from "./actions";

const MESSAGES: Readonly<Record<QuotaState["status"], string>> = {
  idle: "",
  changed: "Límite cambiado.",
  invalid: "Escribe un número positivo (hasta dos decimales).",
  not_found: "No encontramos ese municipio.",
  forbidden: "Hace falta la verificación en dos pasos de operador.",
  error: "No pudimos cambiar el límite. Inténtalo de nuevo.",
};

interface QuotaFormProps {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly resource: UsageResource;
  readonly resourceLabel: string;
  readonly unit: string;
  readonly current: string;
}

/** Changes one municipality's limit for one resource (audited by the database). */
export function QuotaForm({
  tenantId,
  tenantName,
  resource,
  resourceLabel,
  unit,
  current,
}: QuotaFormProps) {
  const id = useId();
  const router = useRouter();
  const [state, action, pending] = useActionState(changeQuotaAction, {
    status: "idle",
  } as QuotaState);
  useEffect(() => {
    if (state.status === "changed") router.refresh();
  }, [state, router]);

  return (
    <form action={action} className="quota-form">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="resource" value={resource} />
      <label htmlFor={id} className="visually-hidden">
        Nuevo límite de {resourceLabel.charAt(0).toLowerCase() + resourceLabel.slice(1)} para{" "}
        {tenantName}, en {unit}
      </label>
      <input
        id={id}
        name="value"
        inputMode="decimal"
        defaultValue={current}
        aria-describedby={`${id}-status`}
        aria-invalid={state.status === "invalid" ? true : undefined}
        required
      />
      <span className="cell-detail" aria-hidden="true">
        {unit}
      </span>
      <button type="submit" className="button button-quiet" disabled={pending}>
        {pending ? "Guardando…" : "Cambiar"}
      </button>
      <span
        id={`${id}-status`}
        className={
          state.status === "changed" || state.status === "idle" ? "field-hint" : "field-error"
        }
        role="status"
      >
        {MESSAGES[state.status]}
      </span>
    </form>
  );
}
