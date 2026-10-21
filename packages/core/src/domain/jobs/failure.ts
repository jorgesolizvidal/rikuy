/**
 * How a job attempt failed. Transient failures (a service that did not answer) are
 * retried with backoff by the ledger; permanent ones (an invalid file, a revoked
 * permission, an exhausted quota) go straight to the dead-letter queue (ADR-014).
 */
export class JobFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: string,
    message: string,
    options: { retryable: boolean; retryAfterSeconds?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JobFailure";
    this.code = isJobErrorCode(code) ? code : "invalid_error_code";
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const transientFailure = (code: string, message: string, retryAfterSeconds?: number) =>
  new JobFailure(
    code,
    message,
    retryAfterSeconds === undefined ? { retryable: true } : { retryable: true, retryAfterSeconds },
  );

export const permanentFailure = (code: string, message: string) =>
  new JobFailure(code, message, { retryable: false });

/** Same format the ledger accepts: snake_case, 2–64 characters. */
export function isJobErrorCode(value: string): boolean {
  return /^[a-z][a-z0-9_]{1,63}$/u.test(value);
}

/**
 * A message that is safe to keep: one line, at most 500 characters, without query strings
 * (where signed URLs carry their tokens).
 */
export function safeJobMessage(message: unknown): string {
  const text = typeof message === "string" ? message : "";
  return text.replace(/\?\S*/gu, "?…").replace(/\s+/gu, " ").trim().slice(0, 500);
}

/** Any thrown value as a failure report; unexpected errors are treated as transient. */
export function toJobFailure(error: unknown): JobFailure {
  if (error instanceof JobFailure) return error;
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "";
  return new JobFailure("unexpected_error", `${name}: ${safeJobMessage(message)}`, {
    retryable: true,
    cause: error,
  });
}
