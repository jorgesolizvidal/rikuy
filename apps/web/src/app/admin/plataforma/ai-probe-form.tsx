"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId } from "react";

import { probeAiAction, type AiProbeState } from "./actions";

const SECONDS = new Intl.NumberFormat("es-BO", { maximumFractionDigits: 1 });

const OUTCOMES: Readonly<Record<string, string>> = {
  tenant_quota: "Sin cuota: el municipio usó su IA de hoy.",
  platform_quota: "La plataforma llegó a su tope de IA de hoy.",
  visitor_limit: "El límite por visitante no se aplica a esta prueba.",
  tenant_unavailable: "El municipio está suspendido: no tiene IA.",
  provider_unavailable: "Groq no respondió: está caído, lento o saturado. Prueba en unos minutos.",
  provider_error:
    "Groq rechazó el pedido. Revisa la clave (GROQ_API_KEY) y el modelo (AI_MODEL) en Vercel.",
  not_configured:
    "La IA no está configurada en este despliegue, o su conexión a la base no responde.",
};

function result(state: AiProbeState): { text: string; ok: boolean } | null {
  switch (state.status) {
    case "idle":
      return null;
    case "forbidden":
      return { text: "Hace falta la verificación en dos pasos de operador.", ok: false };
    case "not_found":
      return { text: "No encontramos ese municipio.", ok: false };
    case "error":
      return { text: "No pudimos hacer la prueba. Inténtalo de nuevo.", ok: false };
    case "done":
      if (state.outcome === "answered") {
        return {
          text: `Respondió «${state.text || "(vacío)"}» en ${SECONDS.format((state.latencyMs ?? 0) / 1000)} s con ${state.model} (${state.tokens} tokens).`,
          ok: true,
        };
      }
      return { text: OUTCOMES[state.outcome] ?? state.outcome, ok: false };
  }
}

/** «Probar la IA» (ADR-036): one minimal request through the gateway, for a municipality. */
export function AiProbeForm({
  tenants,
}: {
  readonly tenants: readonly { readonly tenantId: string; readonly displayName: string }[];
}) {
  const id = useId();
  const router = useRouter();
  const [state, action, pending] = useActionState(probeAiAction, {
    status: "idle",
  } as AiProbeState);
  useEffect(() => {
    if (state.status === "done") router.refresh();
  }, [state, router]);
  const shown = result(state);

  return (
    <form action={action} className="ai-probe">
      <label htmlFor={id}>Municipio</label>
      <select id={id} name="tenantId" required defaultValue={tenants[0]?.tenantId}>
        {tenants.map((tenant) => (
          <option key={tenant.tenantId} value={tenant.tenantId}>
            {tenant.displayName}
          </option>
        ))}
      </select>
      <button type="submit" className="button" disabled={pending || tenants.length === 0}>
        {pending ? "Probando…" : "Probar la IA"}
      </button>
      <div role="status" className="ai-probe-result">
        {shown ? <p className={shown.ok ? "notice" : "field-error"}>{shown.text}</p> : null}
        {state.status === "done" && state.notice ? (
          <p className="field-hint">
            Un visitante leería en su lugar: «{state.notice}» seguido de enlaces a Destinos, Agenda
            y Mapa.
          </p>
        ) : null}
      </div>
    </form>
  );
}
