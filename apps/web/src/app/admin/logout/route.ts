import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { adminSession } from "@/server/admin-session";
import { platformSettings } from "@/server/platform";

/**
 * POST-only logout with an Origin check (CSRF): a third-party page cannot sign the user
 * out, and a GET to /logout does nothing.
 */
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== platformSettings().adminOrigin) {
    return new Response("Forbidden", { status: 403 });
  }
  await (await adminSession()).gateway.signOut();
  redirect("/login");
}
