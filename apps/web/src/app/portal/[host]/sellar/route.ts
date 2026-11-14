import { collectStamp } from "@rikuy/core";

import { publishedStampReader } from "@/server/platform";
import { fromSamePortal } from "@/server/portal-request";
import { portalViewWith } from "@/server/portal-view";

interface StampContext {
  readonly params: Promise<{ host: string }>;
}

const MAX_BODY = 1024;
const NO_STORE = { "cache-control": "no-store" };

/**
 * POST /sellar on the portal's host (ADR-057): `{ code, passport, located }` → a stamp signed
 * by the municipality for the visitor's phone to keep. The municipality comes from the host;
 * the request must come from a page of this same portal. The position is never sent: only
 * whether the phone was within the place's radius. Nothing that identifies the phone is
 * stored: the database adds the stamp to the place's daily totals (ADR-059).
 */
export async function POST(request: Request, { params }: StampContext) {
  const view = await portalViewWith((await params).host, "passport");
  if (view === null) {
    return Response.json({ status: "not_found" }, { status: 404, headers: NO_STORE });
  }
  if (!fromSamePortal(request)) {
    return Response.json({ status: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const text = await request.text();
  let body: unknown = null;
  if (text.length <= MAX_BODY) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  const outcome = await collectStamp(publishedStampReader(), view.context.tenant.tenantId, body);
  const status = outcome.status === "stamped" ? 200 : outcome.status === "invalid" ? 400 : 404;
  return Response.json(outcome, { status, headers: NO_STORE });
}
