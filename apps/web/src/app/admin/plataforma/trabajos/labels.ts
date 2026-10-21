import type { JobAttemptOutcome, JobStatus, ProbeMode } from "@rikuy/core";

export const STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  pending: "En espera",
  running: "En curso",
  succeeded: "Terminado",
  dead_letter: "Fallido",
};

/** Filter tabs: the query value is the status itself. */
export const FILTERS: readonly { readonly status: JobStatus | null; readonly label: string }[] = [
  { status: null, label: "Todos" },
  { status: "dead_letter", label: "Fallidos" },
  { status: "pending", label: "En espera" },
  { status: "running", label: "En curso" },
  { status: "succeeded", label: "Terminados" },
];

export const OUTCOME_LABELS: Readonly<Record<JobAttemptOutcome, string>> = {
  running: "En curso",
  succeeded: "Terminó bien",
  retry: "Falló; se volvió a intentar",
  failed: "Falló",
  lease_expired: "El ejecutor dejó de responder",
};

export const PROBE_MODE_LABELS: Readonly<Record<ProbeMode, string>> = {
  ok: "Normal: termina bien",
  fail_once: "Falla el primer intento (ensayo de reintento)",
  fail_always: "Falla siempre (ensayo de la cola de fallidos)",
};

export const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

/** "hace 7 min", "hace 2 h", "hace 3 días". */
export function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "hace menos de un minuto";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} días`;
}
