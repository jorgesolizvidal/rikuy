import {
  RECOMMENDATION_SOURCES,
  type RecommendationFact,
  type RecommendationsRepository,
  type SavedRecommendations,
} from "@rikuy/core";
import { z } from "zod";

import { failure } from "./content";
import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

/**
 * The Copilot's recommendations (migration 20261117000000, ADR-054), with the signed-in
 * user's session: the database checks the membership, the facts, the numbers and the request
 * behind them. A fact or a target a newer database knows and this build does not is dropped.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const kind = z.enum(["destination", "event"]);

const targetSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("content"), kind, contentId: z.uuid(), proposable: z.boolean() }),
    z.object({
      type: z.literal("scene"),
      kind,
      contentId: z.uuid(),
      tourId: z.uuid(),
      sceneId: z.uuid(),
    }),
    z.object({ type: z.literal("circuit"), circuitId: z.uuid() }),
    z.object({ type: z.literal("question"), question: z.string() }),
    z.object({ type: z.literal("agenda") }),
  ])
  .nullable()
  .catch(null);

const factSchema = z.object({
  id: z.string(),
  source: z.enum(RECOMMENDATION_SOURCES),
  text: z.string(),
  target: targetSchema,
});

/** Saved facts: one a newer database knows and this build does not is dropped. */
export const factsSchema = z.array(z.unknown()).transform((items) =>
  items.flatMap((item): RecommendationFact[] => {
    const parsed = factSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }),
);

export const recommendationItemsSchema = z.array(
  z.object({ title: z.string(), why: z.string(), facts: z.array(z.string()) }),
);

const savedSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  from: day,
  to: day,
  facts: factsSchema,
  items: recommendationItemsSchema,
  mine: z.boolean(),
});

export function createRecommendationsRepository(client: SessionClient): RecommendationsRepository {
  return {
    async latest(tenantId): Promise<SavedRecommendations | null> {
      const { data, error } = await client.rpc("latest_copilot_recommendations", {
        p_tenant_id: tenantId,
      });
      // The web app may be deployed a few minutes before the migration: none yet.
      if (isMissingFunction(error)) return null;
      if (error) throw new Error(`Reading the recommendations failed (${error.code || "unknown"})`);
      return data === null ? null : savedSchema.parse(data);
    },

    async save(input) {
      const { data, error, status } = await client.rpc("save_copilot_recommendations", {
        p_tenant_id: input.tenantId,
        p_ai_request_id: input.aiRequestId,
        p_period_from: input.from,
        p_period_to: input.to,
        p_facts: input.facts,
        p_items: input.items,
      });
      if (error) {
        if (isMissingFunction(error)) return { status: "invalid" };
        const outcome = failure(error, status);
        if (outcome === "forbidden") return { status: "forbidden" };
        if (outcome === "invalid" || error.code === "22023") return { status: "invalid" };
        throw new Error(`Saving the recommendations failed (${error.code || "unknown"})`);
      }
      return { status: "saved", id: z.uuid().parse(data) };
    },
  };
}
