import { after } from "next/server";

import { whatsappChallenge, whatsappSignatureValid, whatsappStatus } from "@/server/ai-gateway";
import { handleWhatsAppDelivery } from "@/server/whatsapp";

/**
 * https://{platform host}/api/whatsapp — Meta's webhook for the municipalities' WhatsApp
 * numbers (A · Paso 6, ADR-075). GET: Meta checks the subscription with the verify token.
 * POST: a delivery, signed with the app secret over its raw bytes; answered at once (Meta
 * retries what is slow) and processed after the response. The body says nothing about which
 * municipality it is for that the database does not check: each message goes to the one its
 * number belongs to.
 */
export const dynamic = "force-dynamic";
/** One delivery can hold a voice note: download, transcription and the answer. */
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const MAX_BODY = 256 * 1024;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const challenge = whatsappChallenge(
    params.get("hub.mode"),
    params.get("hub.verify_token"),
    params.get("hub.challenge"),
  );
  if (challenge === null) return new Response("forbidden", { status: 403, headers: noStore });
  return new Response(challenge, {
    status: 200,
    headers: { ...noStore, "content-type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  if (!whatsappStatus().configured) {
    return Response.json({ error: "not_configured" }, { status: 503, headers: noStore });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) {
    return Response.json({ error: "too_large" }, { status: 413, headers: noStore });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY) {
    return Response.json({ error: "too_large" }, { status: 413, headers: noStore });
  }
  if (!whatsappSignatureValid(body, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: "invalid" }, { status: 400, headers: noStore });
  }
  after(() => handleWhatsAppDelivery(payload));
  return Response.json({ received: true }, { status: 200, headers: noStore });
}
