import {
  ASSISTANT_PAGE_KINDS,
  type UnansweredQuestionsData,
  type UnansweredQuestionsRepository,
} from "@rikuy/core";
import { z } from "zod";

import { isMissingFunction } from "./missing-function";

import type { SessionClient } from "./session-client";

/**
 * «Lo que preguntan los visitantes» (migration 20261116000000, ADR-053), with the signed-in
 * user's session: the database checks that the person is a member of the municipality.
 */

const count = z.union([z.number(), z.string()]).transform(Number);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const unansweredSchema = z.object({
  from: day,
  to: day,
  since: day.nullable(),
  total: count,
  people: count,
  groups: z.array(
    z.object({
      key: z.string(),
      text: z.string(),
      times: count,
      people: count,
      firstAsked: z.string(),
      lastAsked: z.string(),
      lastDay: day,
      langs: z.array(z.enum(["es", "en"])),
      pages: z.array(
        z.object({
          pageKind: z.enum(ASSISTANT_PAGE_KINDS),
          contentId: z.uuid().nullable(),
          kind: z.enum(["destination", "event"]).nullable(),
          slug: z.string().nullable(),
          title: z.string().nullable(),
          sceneTitle: z.string().nullable(),
          times: count,
        }),
      ),
    }),
  ),
});

export function createUnansweredQuestionsRepository(
  client: SessionClient,
): UnansweredQuestionsRepository {
  return {
    async unansweredQuestions(tenantId, days): Promise<UnansweredQuestionsData> {
      const { data, error } = await client.rpc("tenant_unanswered_questions", {
        p_tenant_id: tenantId,
        p_days: days,
      });
      // The web app may be deployed a few minutes before the migration: nothing kept yet.
      if (isMissingFunction(error)) {
        const today = new Date().toISOString().slice(0, 10);
        return { from: today, to: today, since: null, total: 0, people: 0, groups: [] };
      }
      if (error)
        throw new Error(`Reading the unanswered questions failed (${error.code || "unknown"})`);
      return unansweredSchema.parse(data);
    },
  };
}
