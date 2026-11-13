import { redeemVoucher } from "@rikuy/core";

import { publishedRewardReader } from "@/server/platform";
import { fromSamePortal } from "@/server/portal-request";
import { portalView } from "@/server/portal-view";

interface RedeemContext {
  readonly params: Promise<{ host: string }>;
}

const MAX_BODY = 512;
const NO_STORE = { "cache-control": "no-store" };

/**
 * POST /canje/verificar on the portal's host (ADR-058): `{ code, pin, redeem }`. With the
 * voucher's code and the shop's key, checks it (redeem false) or redeems it once. Wrong codes
 * and keys count against 30 per hour in the municipality.
 */
export async function POST(request: Request, { params }: RedeemContext) {
  const view = await portalView((await params).host);
  if (view === null) {
    return Response.json({ status: "wrong" }, { status: 404, headers: NO_STORE });
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
  const outcome = await redeemVoucher(publishedRewardReader(), view.context.tenant.tenantId, body);
  return Response.json(outcome, {
    status: outcome.status === "invalid" ? 400 : outcome.status === "too_many" ? 429 : 200,
    headers: NO_STORE,
  });
}
