import {
  ASSISTANT_PAGE_KINDS,
  type PersonRequestsRepository,
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
/** A count added by a later migration (ADR-073): 0 until the database has it. */
const laterCount = z
  .union([z.number(), z.string()])
  .optional()
  .transform((value) => (value === undefined ? 0 : Number(value)));

export const unansweredSchema = z.object({
  from: day,
  to: day,
  since: day.nullable(),
  total: count,
  people: count,
  askedPerson: laterCount,
  groups: z.array(
    z.object({
      key: z.string(),
      text: z.string(),
      times: count,
      people: count,
      askedPerson: laterCount,
      answered: laterCount,
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

function nothingYet(): UnansweredQuestionsData {
  const today = new Date().toISOString().slice(0, 10);
  return { from: today, to: today, since: null, total: 0, people: 0, groups: [] };
}

export function createUnansweredQuestionsRepository(
  client: SessionClient,
): UnansweredQuestionsRepository & PersonRequestsRepository {
  return {
    async unansweredQuestions(tenantId, days): Promise<UnansweredQuestionsData> {
      const { data, error } = await client.rpc("tenant_unanswered_questions", {
        p_tenant_id: tenantId,
        p_days: days,
      });
      // The web app may be deployed a few minutes before the migration: nothing kept yet.
      if (isMissingFunction(error)) return nothingYet();
      if (error)
        throw new Error(`Reading the unanswered questions failed (${error.code || "unknown"})`);
      return unansweredSchema.parse(data);
    },

    /** «Pidieron hablar con una persona» (migration 20261203000000, ADR-073). */
    async personRequests(tenantId, days): Promise<UnansweredQuestionsData> {
      const { data, error } = await client.rpc("tenant_person_requests", {
        p_tenant_id: tenantId,
        p_days: days,
      });
      if (isMissingFunction(error)) return nothingYet();
      if (error)
        throw new Error(
          `Reading the questions taken to a person failed (${error.code || "unknown"})`,
        );
      return unansweredSchema.parse(data);
    },
  };
}
