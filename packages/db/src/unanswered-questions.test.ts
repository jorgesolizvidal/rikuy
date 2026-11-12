import { describe, expect, it } from "vitest";

import type { SessionClient } from "./session-client";
import { createUnansweredQuestionsRepository } from "./unanswered-questions";

const MUSEO = "5eed2000-0000-4000-8000-000000000001";

function client(result: { data?: unknown; error?: { code: string } | null }) {
  const calls: { fn: string; args: unknown }[] = [];
  const session = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return { data: result.data ?? null, error: result.error ?? null };
    },
  } as unknown as SessionClient;
  return { session, calls };
}

describe("unanswered questions adapter", () => {
  it("reads a period, with counts that may come as text", async () => {
    const { session, calls } = client({
      data: {
        from: "2026-10-14",
        to: "2026-11-12",
        since: "2026-11-12",
        total: "4",
        people: 3,
        groups: [
          {
            key: "hay wifi",
            text: "¿Hay wifi?",
            times: "3",
            people: 2,
            firstAsked: "2026-11-12T14:00:00+00:00",
            lastAsked: "2026-11-12T15:00:00+00:00",
            lastDay: "2026-11-12",
            langs: ["es"],
            pages: [
              {
                pageKind: "destination",
                contentId: MUSEO,
                kind: "destination",
                slug: "museo",
                title: "Museo",
                sceneTitle: null,
                times: 2,
              },
            ],
          },
        ],
      },
    });
    const data = await createUnansweredQuestionsRepository(session).unansweredQuestions("t", 30);
    expect(calls).toEqual([
      { fn: "tenant_unanswered_questions", args: { p_tenant_id: "t", p_days: 30 } },
    ]);
    expect(data.total).toBe(4);
    expect(data.groups[0]).toMatchObject({ times: 3, people: 2, pages: [{ times: 2 }] });
  });

  it("has nothing yet before the migration", async () => {
    const { session } = client({ error: { code: "PGRST202" } });
    const data = await createUnansweredQuestionsRepository(session).unansweredQuestions("t", 7);
    expect(data).toMatchObject({ since: null, total: 0, groups: [] });
  });

  it("fails on any other error, and on a page it does not know", async () => {
    await expect(
      createUnansweredQuestionsRepository(
        client({ error: { code: "42501" } }).session,
      ).unansweredQuestions("t", 7),
    ).rejects.toThrow("42501");
    await expect(
      createUnansweredQuestionsRepository(
        client({
          data: {
            from: "2026-11-06",
            to: "2026-11-12",
            since: null,
            total: 1,
            people: 1,
            groups: [
              {
                key: "x",
                text: "x",
                times: 1,
                people: 1,
                firstAsked: "a",
                lastAsked: "a",
                lastDay: "2026-11-12",
                langs: ["es"],
                pages: [
                  {
                    pageKind: "admin",
                    contentId: null,
                    kind: null,
                    slug: null,
                    title: null,
                    sceneTitle: null,
                    times: 1,
                  },
                ],
              },
            ],
          },
        }).session,
      ).unansweredQuestions("t", 7),
    ).rejects.toThrow();
  });
});
