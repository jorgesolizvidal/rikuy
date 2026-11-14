import { requestVoucher } from "@rikuy/core";

import { publishedRewardReader } from "@/server/platform";
import { fromSamePortal } from "@/server/portal-request";
import { portalViewWith } from "@/server/portal-view";

interface PrizeContext {
  readonly params: Promise<{ host: string }>;
}

// Up to 60 stamps of ~150 bytes each.
const MAX_BODY = 16 * 1024;
const NO_STORE = { "cache-control": "no-store" };

/**
 * POST /premio on the portal's host (ADR-058): `{ circuit, passport, stamps }` → the voucher of
 * the circuit's prize when every stop has a stamp signed by this municipality for this
 * passport. Only from a page of this same portal.
 */
export async function POST(request: Request, { params }: PrizeContext) {
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
  const outcome = await requestVoucher(publishedRewardReader(), view.context.tenant.tenantId, body);
  return Response.json(outcome, {
    status: outcome.status === "invalid" ? 400 : outcome.status === "not_found" ? 404 : 200,
    headers: NO_STORE,
  });
}
