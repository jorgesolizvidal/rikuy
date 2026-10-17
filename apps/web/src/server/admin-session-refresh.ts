import { createSessionClient, createSupabaseAuthGateway, hasSessionCookies } from "@rikuy/db";
import type { NextRequest, NextResponse } from "next/server";

import { stripInternalHeaders } from "./internal-headers";

export interface AdminSessionRefreshOptions {
  readonly url: string;
  readonly publishableKey: string;
  readonly secureCookies: boolean;
}

/**
 * Runs on admin-host requests only. Lets Supabase rotate an expiring access token and
 * writes the new cookies both to the forwarded request (so this render sees them) and
 * to the response (so the browser keeps them). Anonymous requests skip the network call.
 */
export function createAdminSessionRefresher(options: AdminSessionRefreshOptions) {
  return async function refreshAdminSession(
    request: NextRequest,
    respond: (headers: Headers) => NextResponse,
  ): Promise<NextResponse> {
    let response = respond(stripInternalHeaders(request.headers));
    if (!hasSessionCookies(request.cookies.getAll())) return response;

    const client = createSessionClient({
      url: options.url,
      publishableKey: options.publishableKey,
      secureCookies: options.secureCookies,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(list, headers) {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = respond(stripInternalHeaders(request.headers));
          for (const { name, value, options: cookieOptions } of list) {
            response.cookies.set(name, value, cookieOptions);
          }
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    });

    try {
      await createSupabaseAuthGateway(client).currentActor();
    } catch {
      // Identity provider unreachable: render anyway; pages re-check and redirect to login.
    }
    return response;
  };
}
