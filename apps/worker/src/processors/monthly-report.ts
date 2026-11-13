import {
  JOB_KINDS,
  monthlyReportPayloadSchema,
  MonthlyReportError,
  permanentFailure,
  produceMonthlyReport,
  transientFailure,
  type CopilotAiRunner,
  type JobProcessor,
  type Mailer,
  type MonthlyReportStore,
} from "@rikuy/core";

export interface MonthlyReportDeps {
  readonly reports: MonthlyReportStore;
  /** The AI gateway (as the platform, no person); without it the report says so. */
  readonly ai: CopilotAiRunner;
  /** Null when this deployment has no SMTP: the report is kept, nothing is mailed. */
  readonly mailer: Mailer | null;
  /** The panel's origin, for the link in the email. */
  readonly adminOrigin: string;
}

function sentSoFar(checkpoint: unknown): number {
  if (typeof checkpoint !== "object" || checkpoint === null) return 0;
  const sent = (checkpoint as { sent?: unknown }).sent;
  return typeof sent === "number" && Number.isInteger(sent) && sent >= 0 ? sent : 0;
}

/**
 * reports.monthly (ADR-055): the Copilot's recommendations of the month and the email to
 * owners and admins. A retry neither asks the model again (the database knows this job
 * already kept them) nor emails who already got it (the checkpoint counts them).
 */
export function createMonthlyReportProcessor(deps: MonthlyReportDeps): JobProcessor {
  return {
    kind: JOB_KINDS.monthlyReport,
    schemaVersions: [1],
    async run({ job, saveCheckpoint }) {
      if (!monthlyReportPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      try {
        const outcome = await produceMonthlyReport(lease, {
          store: deps.reports,
          ai: deps.ai,
          mailer: deps.mailer,
          adminOrigin: deps.adminOrigin,
          sent: sentSoFar(job.checkpoint),
          saveProgress: (sent) => saveCheckpoint({ sent }),
        });
        return {
          result:
            outcome.outcome === "skipped"
              ? { outcome: "skipped", reason: outcome.reason }
              : {
                  outcome: "done",
                  recommendations: outcome.recommendations,
                  note: outcome.note,
                  mailed: outcome.mailed,
                },
        };
      } catch (error) {
        if (error instanceof MonthlyReportError) {
          if (error.code === "mail_refused") throw permanentFailure(error.code, error.message);
          throw transientFailure(error.code, error.message);
        }
        throw error;
      }
    },
  };
}
