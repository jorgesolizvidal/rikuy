import "server-only";

import type { Actor } from "@rikuy/core";
import {
  createContentRepository,
  createMediaRepository,
  createMembershipReader,
  createSessionClient,
  createInvitationRepository,
  createJobAdminRepository,
  createMemberRepository,
  createMfaGateway,
  createModelRepository,
  createOperationsRepository,
  createPanoramaRepository,
  createPlatformRepository,
  createPlatformUsageRepository,
  createSupabaseAuthGateway,
  createTenantConfigRepository,
  createGeneralTourRepository,
  createTourRepository,
  createUsageRepository,
  type SessionCookieToSet,
} from "@rikuy/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { platformSettings } from "./platform";

type CookieSetOptions = NonNullable<Parameters<Awaited<ReturnType<typeof cookies>>["set"]>[2]>;

/**
 * Per-request admin session (memoized for the duration of one request).
 * Server Actions and Route Handlers can write refreshed cookies; Server Components
 * cannot, which is why the proxy refreshes the session before rendering.
 */
export const adminSession = cache(async () => {
  const store = await cookies();
  const { env, secureCookies } = platformSettings();
  const client = createSessionClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    secureCookies,
    cookies: {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll(list: SessionCookieToSet[]) {
        try {
          for (const { name, value, options } of list)
            store.set(name, value, options as CookieSetOptions);
        } catch {
          // Called from a Server Component: cookies are read-only there. The proxy already
          // refreshed the session for this request, so nothing is lost.
        }
      },
    },
  });
  return {
    gateway: createSupabaseAuthGateway(client),
    memberships: createMembershipReader(client),
    config: createTenantConfigRepository(client),
    platform: createPlatformRepository(client),
    invitations: createInvitationRepository(client),
    members: createMemberRepository(client),
    mfa: createMfaGateway(client),
    media: createMediaRepository(client),
    content: createContentRepository(client),
    panoramas: createPanoramaRepository(client),
    models: createModelRepository(client),
    usage: createUsageRepository(client),
    platformUsage: createPlatformUsageRepository(client),
    tours: createTourRepository(client),
    general: createGeneralTourRepository(client),
    jobs: createJobAdminRepository(client),
    operations: createOperationsRepository(client),
  };
});

/** The signed-in actor, verified with the identity provider, or null. */
export const currentAdminActor = cache(async (): Promise<Actor | null> => {
  return (await adminSession()).gateway.currentActor();
});

/** The signed-in actor, or a redirect to the login page. */
export async function requireAdminActor(): Promise<Actor> {
  const actor = await currentAdminActor();
  if (actor === null) redirect("/login");
  return actor;
}
