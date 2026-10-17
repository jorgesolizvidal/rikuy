import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { adminSession } from "@/server/admin-session";

/** Target of the email link (PKCE): exchanges the one-time code for a session cookie. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const ok =
    code !== null &&
    code.length <= 512 &&
    (await (await adminSession()).gateway.exchangeAuthCode(code));
  redirect(ok ? "/" : "/login?error=link");
}
