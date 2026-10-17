import type { NextRequest } from "next/server";

import { createPortalProxy } from "./server/portal-proxy";
import { platformDeps } from "./server/platform";

let handler: ReturnType<typeof createPortalProxy> | undefined;

export async function proxy(request: NextRequest) {
  handler ??= createPortalProxy(platformDeps());
  return handler(request);
}

export const config = {
  // Everything except Next.js build assets. New public files must be added here explicitly.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
