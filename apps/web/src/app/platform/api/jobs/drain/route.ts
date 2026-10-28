import { after, NextResponse } from "next/server";

import {
  isJobRunnerRequest,
  jobRunnerConfigured,
  KICK_RUN,
  runDailyReport,
  runJobQueue,
} from "@/server/job-runner";

/**
 * POST https://{platform host}/api/jobs/drain — the database wakes the job runner here
 * (pg_net, with the runner secret from Supabase Vault). Answers at once and drains the
 * queue after the response, within the function's time limit.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };

export async function POST(request: Request) {
  if (!jobRunnerConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503, headers: noStore });
  }
  if (!isJobRunnerRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }
  // The body only says why the database called (ADR-025, ADR-035); it grants nothing.
  const reason = await request
    .json()
    .then((body: unknown) => (body as { reason?: unknown } | null)?.reason)
    .catch(() => null);
  after(async () => {
    try {
      if (reason === "daily") await runDailyReport();
      await runJobQueue(KICK_RUN);
    } catch (error) {
      // The ledger stays consistent: leases expire and the next wake-up retries.
      console.error(
        JSON.stringify({
          level: "error",
          event: "drain.failed",
          error: error instanceof Error ? error.name : "unknown",
          code: (error as { code?: unknown } | null)?.code ?? null,
          at: new Date().toISOString(),
        }),
      );
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202, headers: noStore });
}
