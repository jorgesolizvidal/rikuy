import { askPortalAssistant } from "@/server/portal-assistant";
import { portalView } from "@/server/portal-view";

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
export async function POST(request: Request, { params }: AssistantContext) {
  const view = await portalView((await params).host);
  if (view === null)
    return Response.json({ status: "not_found" }, { status: 404, headers: NO_STORE });

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  let sameOrigin = false;
  try {
    sameOrigin = origin !== null && host !== null && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin)
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

  // The visitor's limit counts by address; the database keeps only a daily-salted hash.
  const visitor =
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  const { reply } = await askPortalAssistant(view, body, visitor?.slice(0, 64) ?? null);
  return Response.json(reply, {
    status: reply.status === "invalid" ? 400 : 200,
    headers: NO_STORE,
  });
}
