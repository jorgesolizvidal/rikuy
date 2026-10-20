import {
  JOB_KINDS,
  permanentFailure,
  probePayloadSchema,
  transientFailure,
  type JobProcessor,
} from "@rikuy/core";

/** Waits, but returns as soon as the runner says to stop. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * «Probar el ejecutor» (system.probe): changes no data. It checks the whole path — claim,
 * lease, heartbeat, result — and, on request, rehearses failures for the runbook:
 * `fail_once` fails its first attempt (one retry), `fail_always` ends in dead-letter.
 */
export const probeProcessor: JobProcessor = {
  kind: JOB_KINDS.probe,
  schemaVersions: [1],
  async run({ job, signal, saveCheckpoint }) {
    const parsed = probePayloadSchema.safeParse(job.payload);
    if (!parsed.success)
      throw permanentFailure("invalid_payload", "The probe payload is not valid.");
    const { mode, workMs } = parsed.data;

    await pause(workMs / 2, signal);
    await saveCheckpoint({ halfway: true });
    await pause(workMs / 2, signal);

    if (mode === "fail_always" || (mode === "fail_once" && job.attemptNo === 1)) {
      throw transientFailure("probe_failure", `Probe failure requested (${mode}).`);
    }
    return { result: { mode, attemptNo: job.attemptNo, workedMs: workMs } };
  },
};
