import { after } from "next/server";

import { recordUnansweredQuestion } from "@/server/ai-gateway";
import { askPortalAssistant } from "@/server/portal-assistant";
import { fromSamePortal, visitorKey } from "@/server/portal-request";
import { portalViewWith } from "@/server/portal-view";
import { measured } from "@/server/measured-route";

interface AssistantContext {
  readonly params: Promise<{ host: string }>;
}

/** Two model calls of up to 20 s each, and the search between them. */
export const maxDuration = 60;

const MAX_BODY = 32 * 1024;
const NO_STORE = { "cache-control": "no-store" };

/**
 * The visitor's assistant (ADR-038): POST /asistente on the portal's host. The municipality
 * comes from the host, never from the body; the request must come from a page of this same
 * portal (Origin), and the answer is never cached.
 */
async function handle(request: Request, { params }: AssistantContext) {
  const view = await portalViewWith((await params).host, "assistant");
  if (view === null)
    return Response.json({ status: "not_found" }, { status: 404, headers: NO_STORE });

  if (!fromSamePortal(request))
    return Response.json({ status: "forbidden" }, { status: 403, headers: NO_STORE });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return Response.json({ status: "invalid" }, { status: 415, headers: NO_STORE });
  }
  const text = await request.text();
  if (text.length > MAX_BODY) {
    return Response.json({ status: "invalid" }, { status: 413, headers: NO_STORE });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  const { reply, unanswered } = await askPortalAssistant(view, body, visitorKey(request));
  // A question nothing published could answer is kept for the municipality (ADR-053), after
  // the answer is on its way.
  if (unanswered) {
    const tenantId = view.context.tenant.tenantId;
    after(() => recordUnansweredQuestion(tenantId, unanswered));
  }
  return Response.json(reply, {
    status: reply.status === "invalid" ? 400 : 200,
    headers: NO_STORE,
  });
}

/** Timed per municipality and hour (ADR-044). */
export const POST = measured("assistant", handle);
