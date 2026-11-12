import {
  downloadStatistics,
  organizationAccess,
  parseStatisticsDownload,
  parseStatisticsPeriod,
} from "@rikuy/core";
import { type NextRequest } from "next/server";

import { adminSession, currentAdminActor } from "@/server/admin-session";

/**
 * The period's totals per day as a CSV (C1 · Paso 2, ADR-052), for any member of the
 * municipality. A route handler cannot redirect to the login or to /verificacion like a page:
 * without access it answers 404, so it never reveals other municipalities.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const notFound = () =>
    new Response("No encontrado", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  const kind = parseStatisticsDownload(request.nextUrl.searchParams.get("tipo"));
  if (kind === null) return notFound();
  const actor = await currentAdminActor();
  if (actor === null) return notFound();
  const session = await adminSession();
  const access = await organizationAccess(actor, (await params).slug, session.memberships);
  if (access.status !== "open") return notFound();

  const period = parseStatisticsPeriod(request.nextUrl.searchParams.get("periodo"));
  const file = await downloadStatistics(access.membership, session.statistics, period, kind);
  return new Response(file.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
