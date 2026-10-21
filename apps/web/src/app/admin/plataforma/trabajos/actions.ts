"use server";

import { replayJob, requestProbe } from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";

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
