"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { tenantStatusAction, type StatusState } from "./actions";

const MESSAGES: Partial<Record<StatusState["status"], string>> = {
  owner_pending: "El propietario aún no aceptó la invitación.",
  invalid_transition: "Ese cambio de estado no está permitido.",
  not_found: "El municipio ya no existe.",
  forbidden: "Tu sesión de operador ya no es válida. Recarga la página.",
  error: "No se pudo cambiar el estado. Inténtalo de nuevo.",
};

export function TenantStatusButton({
  tenantId,
  target,
  label,
  disabledReason = null,
}: {
  readonly tenantId: string;
  readonly target: "active" | "suspended";
  readonly label: string;
  readonly disabledReason?: string | null;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(tenantStatusAction, {
    status: "idle",
  } as StatusState);

  useEffect(() => {
    if (state.status === "updated") router.refresh();
  }, [state, router]);

  const message = MESSAGES[state.status] ?? disabledReason;

  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="status" value={target} />
      <button
        type="submit"
        className={target === "active" ? "button" : "button button-quiet"}
        disabled={pending || disabledReason !== null}
      >
        {pending ? "Guardando…" : label}
      </button>
      {message ? (
        <span className="org-detail" role="status">
          {message}
        </span>
      ) : null}
    </form>
  );
}
