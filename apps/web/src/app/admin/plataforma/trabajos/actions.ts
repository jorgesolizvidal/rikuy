"use server";

import { operatorGate, replayJob, requestProbe } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { OPERATOR_RUN, runJobQueue } from "@/server/job-runner";

// The database re-checks the operator and its second factor on every call. No redirects:
// the client refreshes on success.

export interface ReplayState {
  readonly status: "idle" | "replayed" | "stale" | "not_found" | "forbidden" | "error";
}

export async function replayJobAction(
  _previous: ReplayState,
  formData: FormData,
): Promise<ReplayState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { jobs } = await adminSession();
    const result = await replayJob(jobs, {
      jobId: formData.get("jobId"),
      generation: formData.get("generation"),
    });
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

export interface ProbeState {
  readonly status: "idle" | "enqueued" | "not_found" | "invalid" | "forbidden" | "error";
}

export async function requestProbeAction(
  _previous: ProbeState,
  formData: FormData,
): Promise<ProbeState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { jobs } = await adminSession();
    const result = await requestProbe(jobs, {
      tenantId: formData.get("tenantId"),
      mode: formData.get("mode"),
    });
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

export interface RunQueueState {
  readonly status: "idle" | "done" | "not_configured" | "forbidden" | "error";
  readonly claimed?: number;
  readonly succeeded?: number;
  readonly retried?: number;
  readonly deadLettered?: number;
}

/** «Procesar la cola ahora»: a short run of the job runner, for operators with MFA only. */
export async function runQueueNowAction(): Promise<RunQueueState> {
  try {
    if ((await currentAdminActor()) === null) return { status: "forbidden" };
    const { platform, mfa } = await adminSession();
    if ((await operatorGate(platform, mfa)).status !== "granted") return { status: "forbidden" };
    const report = await runJobQueue(OPERATOR_RUN);
    if (report === null) return { status: "not_configured" };
    return {
      status: "done",
      claimed: report.claimed,
      succeeded: report.succeeded,
      retried: report.retried,
      deadLettered: report.deadLettered,
    };
  } catch {
    return { status: "error" };
  }
}
