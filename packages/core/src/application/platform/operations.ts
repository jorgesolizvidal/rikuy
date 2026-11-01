import { z } from "zod";

import type { Mailer, OutgoingEmail } from "../mail/invitations";
import type { PlatformRepository } from "./ports";

/**
 * Operation on free plans (ADR-035): what the plans can run out of, the queue's health and
 * the municipalities close to a quota. Operators see it in /plataforma; the runner reads it
 * once a day and emails the operators only when something needs a look.
 */

const count = z.number().int().nonnegative();

export const operationsSnapshotSchema = z.object({
  storage: z.object({ bytes: count, limit: count }),
  database: z.object({ bytes: count, limit: count }),
  jobs: z.object({ failed24h: count, waitingSeconds: count }),
  quotas: z.array(
    z.object({
      tenant: z.string(),
      slug: z.string(),
      resource: z.enum(["storage_bytes", "media_compute_seconds"]),
      used: count,
      limit: count,
    }),
  ),
  unusedMedia: z.object({ removed7d: count, bytes7d: count }),
  // ADR-036: today's platform cap (UTC) and the municipalities at 80 % of their AI quota.
  // Optional: a database without the AI gateway yet has no such key.
  ai: z
    .object({
      used: count,
      limit: count,
      answered24h: count,
      refused24h: count,
      failed24h: count,
      quotas: z.array(
        z.object({ tenant: z.string(), slug: z.string(), used: count, limit: count }),
      ),
    })
    .optional(),
  at: z.string(),
});
export type OperationsSnapshot = z.infer<typeof operationsSnapshotSchema>;

export const operationsReportSchema = operationsSnapshotSchema.extend({
  operators: z.array(z.string()),
});
export type OperationsReport = z.infer<typeof operationsReportSchema>;

export interface OperationsAlert {
  readonly level: "warning" | "critical";
  readonly code:
    "storage" | "database" | "failed_jobs" | "queue_stuck" | "quota" | "ai_platform" | "ai_quota";
  readonly message: string;
}

/** Work waiting longer than this means the runner is not being woken. */
export const QUEUE_STUCK_SECONDS = 15 * 60;

/** "120 MB", or "1 GB" from a gigabyte on. */
export function formatStorage(bytes: number): string {
  const format = new Intl.NumberFormat("es", { maximumFractionDigits: 1 });
  return bytes >= 1_073_741_824
    ? `${format.format(bytes / 1_073_741_824)} GB`
    : `${format.format(bytes / 1_048_576)} MB`;
}

/** "12.500" tokens, with the Spanish thousands separator. */
export function formatTokens(tokens: number): string {
  return new Intl.NumberFormat("es", { maximumFractionDigits: 0, useGrouping: true }).format(
    tokens,
  );
}

function share(used: number, limit: number): number {
  return limit > 0 ? used / limit : 0;
}

const percent = (value: number) => `${Math.round(value * 100)} %`;

/** What needs a look, most serious first. Nothing: an empty list. */
export function operationsAlerts(snapshot: OperationsSnapshot): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  const level = (ratio: number) => (ratio >= 0.95 ? "critical" : "warning");

  const storage = share(snapshot.storage.bytes, snapshot.storage.limit);
  if (storage >= 0.8) {
    alerts.push({
      level: level(storage),
      code: "storage",
      message: `El almacenamiento del proyecto está al ${percent(storage)}: ${formatStorage(snapshot.storage.bytes)} de ${formatStorage(snapshot.storage.limit)}. Revisa las cuotas o pasa a un plan pago.`,
    });
  }
  const database = share(snapshot.database.bytes, snapshot.database.limit);
  if (database >= 0.8) {
    alerts.push({
      level: level(database),
      code: "database",
      message: `La base de datos está al ${percent(database)}: ${formatStorage(snapshot.database.bytes)} de ${formatStorage(snapshot.database.limit)}.`,
    });
  }
  if (snapshot.jobs.waitingSeconds >= QUEUE_STUCK_SECONDS) {
    alerts.push({
      level: "critical",
      code: "queue_stuck",
      message: `Hay trabajos esperando desde hace ${Math.round(snapshot.jobs.waitingSeconds / 60)} min: el ejecutor no se está despertando. Revisa /plataforma/trabajos y la activación del ejecutor.`,
    });
  }
  if (snapshot.jobs.failed24h > 0) {
    alerts.push({
      level: "warning",
      code: "failed_jobs",
      message: `${snapshot.jobs.failed24h === 1 ? "Un trabajo falló" : `${snapshot.jobs.failed24h} trabajos fallaron`} en las últimas 24 h. Revisa «Fallidos» en /plataforma/trabajos.`,
    });
  }
  for (const quota of snapshot.quotas) {
    const ratio = share(quota.used, quota.limit);
    const what =
      quota.resource === "storage_bytes"
        ? `${formatStorage(quota.used)} de ${formatStorage(quota.limit)} de almacenamiento`
        : `${Math.round(quota.used / 60)} de ${Math.round(quota.limit / 60)} min de procesamiento este mes`;
    alerts.push({
      level: level(ratio),
      code: "quota",
      message: `${quota.tenant} usa el ${percent(ratio)} de su cuota: ${what}.`,
    });
  }
  if (snapshot.ai !== undefined) {
    const ai = share(snapshot.ai.used, snapshot.ai.limit);
    if (ai >= 0.8) {
      alerts.push({
        level: level(ai),
        code: "ai_platform",
        message: `La IA de la plataforma va por el ${percent(ai)} de su tope de hoy: ${formatTokens(snapshot.ai.used)} de ${formatTokens(snapshot.ai.limit)} tokens. Al llegar al tope, el asistente deja de responder en todos los municipios hasta mañana.`,
      });
    }
    for (const quota of snapshot.ai.quotas) {
      const ratio = share(quota.used, quota.limit);
      alerts.push({
        level: level(ratio),
        code: "ai_quota",
        message: `${quota.tenant} usa el ${percent(ratio)} de su cuota de IA de hoy: ${formatTokens(quota.used)} de ${formatTokens(quota.limit)} tokens.`,
      });
    }
  }
  return alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The daily email to one operator: the alerts, and where to look. */
export function operationsEmail(input: {
  readonly to: string;
  readonly alerts: readonly OperationsAlert[];
  readonly snapshot: OperationsSnapshot;
  readonly adminOrigin: string;
}): OutgoingEmail {
  const critical = input.alerts.some((alert) => alert.level === "critical");
  const subject = `${critical ? "Urgente" : "Revisar"}: ${input.alerts.length === 1 ? "1 aviso" : `${input.alerts.length} avisos`} de la plataforma`;
  const panel = `${input.adminOrigin}/plataforma`;
  const lines = input.alerts.map(
    (alert) => `${alert.level === "critical" ? "[!] " : ""}${alert.message}`,
  );
  const storage = `${formatStorage(input.snapshot.storage.bytes)} de ${formatStorage(input.snapshot.storage.limit)}`;
  const text = [
    "Hola:",
    "",
    "El control diario de la plataforma encontró esto:",
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    `Almacenamiento del proyecto: ${storage}.`,
    `Detalle en ${panel}.`,
    "",
    "Rikuy",
  ].join("\n");
  const html = [
    '<!doctype html><html lang="es"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2328">',
    "<p>Hola:</p><p>El control diario de la plataforma encontró esto:</p><ul>",
    ...lines.map((line) => `<li>${escapeHtml(line)}</li>`),
    "</ul>",
    `<p>Almacenamiento del proyecto: ${escapeHtml(storage)}.</p>`,
    `<p>Detalle en <a href="${escapeHtml(panel)}">${escapeHtml(panel)}</a>.</p><p>Rikuy</p></body></html>`,
  ].join("");
  return { to: input.to, subject, text, html };
}

/** The runner's side: the report with the operators' addresses. */
export interface OperationsReportReader {
  operationsReport(): Promise<OperationsReport>;
}

export interface DailyReportOutcome {
  readonly alerts: readonly OperationsAlert[];
  readonly sent: number;
  readonly failed: number;
  readonly mail: "sent" | "nothing_to_report" | "not_configured" | "no_operators";
}

/** Once a day: emails the operators only when something needs a look. */
export async function sendDailyReport(deps: {
  readonly reader: OperationsReportReader;
  readonly mailer: Mailer | null;
  readonly adminOrigin: string;
}): Promise<DailyReportOutcome> {
  const report = await deps.reader.operationsReport();
  const alerts = operationsAlerts(report);
  if (alerts.length === 0) return { alerts, sent: 0, failed: 0, mail: "nothing_to_report" };
  if (deps.mailer === null) return { alerts, sent: 0, failed: 0, mail: "not_configured" };
  if (report.operators.length === 0) return { alerts, sent: 0, failed: 0, mail: "no_operators" };
  let sent = 0;
  let failed = 0;
  for (const to of report.operators) {
    try {
      await deps.mailer.send(
        operationsEmail({ to, alerts, snapshot: report, adminOrigin: deps.adminOrigin }),
      );
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { alerts, sent, failed, mail: "sent" };
}

/** The operator's view in /plataforma (second factor checked in the database). */
export interface OperationsRepository {
  snapshot(): Promise<OperationsSnapshot | null>;
}

export async function loadOperations(
  platform: Pick<PlatformRepository, "operatorAccess">,
  operations: OperationsRepository,
): Promise<{ readonly snapshot: OperationsSnapshot; readonly alerts: OperationsAlert[] } | null> {
  if ((await platform.operatorAccess()) !== "ok") return null;
  const snapshot = await operations.snapshot();
  return snapshot ? { snapshot, alerts: operationsAlerts(snapshot) } : null;
}
