import type { PlanTraitReader, PlanTraits } from "@rikuy/core";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { unexpected, type SupabasePublishedContentReaderOptions } from "./content";
import { isMissingFunction } from "./missing-function";

const traitRowSchema = z.object({
  kind: z.enum(["destination", "event"]),
  slug: z.string(),
  visit_minutes: z.number().int().nullable(),
  kids: z.boolean().nullable(),
});

/**
 * The visit time and «for children» of what is published (ADR-072), by `kind:slug`, for the
 * plans of the visitor's assistant. Publishable key: the function checks what is public.
 * Before the migration (the web goes out a few minutes earlier) the plans go without them.
 */
export function createSupabasePlanTraitReader(
  options: SupabasePublishedContentReaderOptions,
): PlanTraitReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async planTraits(tenantId) {
      const { data, error } = await client
        .rpc("portal_plan_traits", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (isMissingFunction(error)) return new Map();
      if (error) throw unexpected("Reading the visit times of the plans", error);
      const traits = new Map<string, PlanTraits>();
      for (const row of z.array(traitRowSchema).parse(data)) {
        traits.set(`${row.kind}:${row.slug}`, { visitMinutes: row.visit_minutes, kids: row.kids });
      }
      return traits;
    },
  };
}
