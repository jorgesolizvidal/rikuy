import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Request-scoped Supabase client whose session lives in HTTP cookies (BFF pattern).
 *
 * - Create ONE per request; never share it between users.
 * - Cookies are host-only (no Domain attribute), HttpOnly and SameSite=Lax: the session
 *   is only ever sent to the admin host and is not readable by page JavaScript. No
 *   browser Supabase client exists, so the refresh token never reaches client code.
 * - Queries run with the user's JWT, so Row Level Security applies to every read.
 */

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
}

export interface SessionCookieToSet extends SessionCookie {
  readonly options: Record<string, unknown>;
}

export interface SessionCookieStore {
  getAll(): SessionCookie[];
  /** `headers` must be applied to the response (they forbid caching a response that sets a session). */
  setAll(cookies: SessionCookieToSet[], headers: Record<string, string>): void;
}

export interface SessionClientOptions {
  readonly url: string;
  readonly publishableKey: string;
  readonly cookies: SessionCookieStore;
  /** `true` everywhere except plain-http local development. */
  readonly secureCookies: boolean;
  readonly fetch?: typeof fetch;
}

export type SessionClient = SupabaseClient;

export function createSessionClient(options: SessionClientOptions): SessionClient {
  return createServerClient(options.url, options.publishableKey, {
    cookies: {
      getAll: () => options.cookies.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (cookies, headers) =>
        options.cookies.setAll(
          cookies.map(({ name, value, options: cookieOptions }) => ({
            name,
            value,
            options: { ...cookieOptions },
          })),
          headers,
        ),
    },
    cookieOptions: {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: options.secureCookies,
    },
    auth: { detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
}

/** True when the request carries Supabase auth cookies (avoids network calls for anonymous visitors). */
export function hasSessionCookies(cookies: readonly SessionCookie[]): boolean {
  return cookies.some(
    (cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("-auth-token"),
  );
}
