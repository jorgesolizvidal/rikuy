import "server-only";

import type { Actor } from "@rikuy/core";
import {
  createAiUsageRepository,
  createContentRepository,
  createCopilotRepository,
  createEvalRepository,
  createMediaLibraryRepository,
  createMediaRepository,
  createMembershipReader,
  createMetricsRepository,
  createSessionClient,
  createInvitationRepository,
  createJobAdminRepository,
  createKnowledgeRepository,
  createMemberRepository,
  createMfaGateway,
  createModelRepository,
  createOperationsRepository,
  createPanoramaRepository,
  createPlatformAiUsageRepository,
  createPlatformRepository,
  createPlatformUsageRepository,
  createStatisticsRepository,
  createUnansweredQuestionsRepository,
  createMonthlyReportRepository,
  createPassportRepository,
  createStampCodeRepository,
  createRecommendationsRepository,
  createSupabaseAuthGateway,
  createTenantConfigRepository,
  createGeneralTourRepository,
  createTourRemovalRepository,
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
    metrics: createMetricsRepository(client),
    evals: createEvalRepository(client),
    mfa: createMfaGateway(client),
    media: createMediaRepository(client),
    content: createContentRepository(client),
    copilot: createCopilotRepository(client),
    knowledge: createKnowledgeRepository(client),
    panoramas: createPanoramaRepository(client),
    models: createModelRepository(client),
    library: createMediaLibraryRepository(client),
    usage: createUsageRepository(client),
    statistics: createStatisticsRepository(client),
    questions: createUnansweredQuestionsRepository(client),
    recommendations: createRecommendationsRepository(client),
    reports: createMonthlyReportRepository(client),
    passport: createPassportRepository(client),
    stampCodes: createStampCodeRepository(client),
    platformUsage: createPlatformUsageRepository(client),
    aiUsage: createAiUsageRepository(client),
    platformAiUsage: createPlatformAiUsageRepository(client),
    tours: createTourRepository(client),
    tourRemoval: createTourRemovalRepository(client),
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
