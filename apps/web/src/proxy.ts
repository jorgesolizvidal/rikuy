import type { NextRequest } from "next/server";

import { createAdminSessionRefresher } from "./server/admin-session-refresh";
import { platformSettings, tenantDirectory } from "./server/platform";
import { createPortalProxy } from "./server/portal-proxy";

let handler: ReturnType<typeof createPortalProxy> | undefined;

export async function proxy(request: NextRequest) {
  if (!handler) {
    const { env, hosts, secureCookies } = platformSettings();
    handler = createPortalProxy({
      hosts,
      directory: tenantDirectory(),
      refreshAdminSession: createAdminSessionRefresher({
        url: env.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        secureCookies,
      }),
    });
  }
  return handler(request);
}

export const config = {
  // Everything except Next.js build assets. New public files must be added here explicitly.
  // vendor/: versioned third-party files (the map worker), the same for every host.
  // _vercel/: Vercel's own endpoints (Speed Insights), served by the platform.
  matcher: ["/((?!_next/static|_next/image|_vercel/|favicon.ico|vendor/).*)"],
};
