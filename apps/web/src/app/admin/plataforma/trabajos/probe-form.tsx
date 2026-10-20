"use client";

import type { ProbeMode } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { requestProbeAction, type ProbeState } from "./actions";
import { PROBE_MODE_LABELS } from "./labels";

// Only types from @rikuy/core here: its main entry carries zod, not needed in the browser.
const MODES = Object.keys(PROBE_MODE_LABELS) as ProbeMode[];

const MESSAGES: Partial<Record<ProbeState["status"], string>> = {
  enqueued: "Prueba en la cola. Aparece en la lista; el ejecutor la toma en su próxima pasada.",
  not_found: "Ese municipio ya no existe.",
  invalid: "Elige un tipo de prueba válido.",
  forbidden: "Tu sesión de operador ya no es válida. Recarga la página.",
  error: "No se pudo pedir la prueba. Inténtalo de nuevo.",
};

/** «Probar el ejecutor»: a job that changes nothing, to check the whole path. */
export function ProbeForm({
  tenants,
}: {
  readonly tenants: readonly { readonly tenantId: string; readonly displayName: string }[];
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(requestProbeAction, {
    status: "idle",
  } as ProbeState);

  useEffect(() => {
    if (state.status === "enqueued") router.refresh();
  }, [state, router]);

  const message = MESSAGES[state.status];

  return (
    <form action={action} className="probe-form">
      <div className="field">
        <label htmlFor="probe-tenant">Municipio</label>
        <select id="probe-tenant" name="tenantId" required defaultValue={tenants[0]?.tenantId}>
          {tenants.map((tenant) => (
            <option key={tenant.tenantId} value={tenant.tenantId}>
              {tenant.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="probe-mode">Tipo de prueba</label>
        <select id="probe-mode" name="mode" defaultValue="ok">
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {PROBE_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
      <p>
        <button type="submit" className="button" disabled={pending || tenants.length === 0}>
          {pending ? "Pidiendo…" : "Probar el ejecutor"}
        </button>
      </p>
      <p className="org-detail" role="status">
        {message}
      </p>
    </form>
  );
}
