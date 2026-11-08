import type { Instrumentation } from "next";

/**
 * Every server error (pages, route handlers, Server Actions) is recorded with the proxy's
 * request ID, its municipality and Next's digest (ADR-044). Only in the Node.js runtime,
 * where the telemetry connection lives; a failure to record is swallowed.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordServerError } = await import("./server/telemetry");
  await recordServerError({
    path: request.path,
    method: request.method,
    headers: request.headers,
    routePath: context.routePath,
    error,
  });
};
