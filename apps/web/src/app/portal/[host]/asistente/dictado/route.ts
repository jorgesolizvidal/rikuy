import { DICTATION_LIMITS, DICTATION_MESSAGES } from "@rikuy/core";

import { transcribePortalDictation } from "@/server/portal-assistant";
import { fromSamePortal, visitorKey } from "@/server/portal-request";
import { portalView } from "@/server/portal-view";

interface DictationContext {
  readonly params: Promise<{ host: string }>;
}

/** Two provider calls of up to 20 s each. */
export const maxDuration = 60;

const NO_STORE = { "cache-control": "no-store" };

/**
 * Dictation of the visitor's assistant (ADR-041): POST /asistente/dictado on the portal's
 * host, with the recording as the body. The municipality comes from the host; the request
 * must come from a page of this same portal. The answer is text for the visitor to review
 * (never sent as a question by itself), or a short message: the visitor can always type.
 * Neither the audio nor the text is kept.
 */
export async function POST(request: Request, { params }: DictationContext) {
  const view = await portalView((await params).host);
  if (view === null)
    return Response.json({ status: "not_found" }, { status: 404, headers: NO_STORE });
  if (!fromSamePortal(request))
    return Response.json({ status: "forbidden" }, { status: 403, headers: NO_STORE });
  if (!(request.headers.get("content-type") ?? "").startsWith("audio/")) {
    return Response.json(
      { status: "invalid", message: DICTATION_MESSAGES.not_audio },
      { status: 415, headers: NO_STORE },
    );
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > DICTATION_LIMITS.maxBytes) {
    return Response.json(
      { status: "invalid", message: DICTATION_MESSAGES.too_long },
      { status: 413, headers: NO_STORE },
    );
  }
  const audio = await readAtMost(request, DICTATION_LIMITS.maxBytes);
  if (audio === null) {
    return Response.json(
      { status: "invalid", message: DICTATION_MESSAGES.too_long },
      { status: 413, headers: NO_STORE },
    );
  }

  const { reply } = await transcribePortalDictation(view, audio, visitorKey(request));
  return Response.json(reply, {
    status: reply.status === "invalid" ? 400 : 200,
    headers: NO_STORE,
  });
}

/** The body, or null as soon as it passes the limit (a missing Content-Length is no excuse). */
async function readAtMost(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const audio = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    audio.set(chunk, at);
    at += chunk.byteLength;
  }
  return audio;
}
