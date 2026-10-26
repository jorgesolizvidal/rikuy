import { describe, expect, it } from "vitest";

import type { SessionClient } from "./session-client";
import { createTourRepository } from "./tours";

function client(result: { data?: unknown; error?: { code: string; hint?: string } | null }) {
  const calls: { fn: string; args: unknown }[] = [];
  const session = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return {
        data: result.data ?? null,
        error: result.error ?? null,
        status: result.error ? 400 : 200,
      };
    },
  } as unknown as SessionClient;
  return { session, calls };
}

const T = "5eed1000-0000-4000-8000-000000000001";
const TOUR = "70000000-0000-4000-8000-000000000001";
const SCENE = "70000000-0000-4000-8000-0000000000a1";

describe("tour repository", () => {
  it("returns the new edit number of an edit, sending only the changed fields", async () => {
    const { session, calls } = client({ data: [{ revision_id: TOUR, edit_count: 7 }] });
    expect(
      await createTourRepository(session).updateScene(T, TOUR, 6, SCENE, { title: "Patio" }),
    ).toEqual({
      status: "saved",
      editCount: 7,
    });
    expect(calls[0]).toEqual({
      fn: "update_tour_scene",
      args: {
        p_tenant_id: T,
        p_tour_id: TOUR,
        p_expected_edit: 6,
        p_scene_id: SCENE,
        p_changes: { title: "Patio" },
      },
    });
  });

  it("maps database refusals to outcomes", async () => {
    const cases = [
      [{ code: "PT409" }, { status: "conflict" }],
      [{ code: "PT409", hint: "duplicate" }, { status: "duplicate" }],
      [
        { code: "23514", hint: "panorama" },
        { status: "invalid", reason: "panorama" },
      ],
      [{ code: "23514" }, { status: "invalid", reason: "shape" }],
      [{ code: "42501" }, { status: "forbidden" }],
      [{ code: "PT404" }, { status: "not_found" }],
    ] as const;
    for (const [error, outcome] of cases) {
      const { session } = client({ error });
      expect(await createTourRepository(session).addScene(T, TOUR, null, SCENE, "Sala")).toEqual(
        outcome,
      );
    }
    await expect(
      createTourRepository(client({ error: { code: "XX000" } }).session).addScene(
        T,
        TOUR,
        1,
        SCENE,
        "S",
      ),
    ).rejects.toThrow("Adding a scene failed (XX000)");
  });

  it("tells apart an existing tour, an incomplete publication and a draft that was never published", async () => {
    expect(
      await createTourRepository(
        client({ error: { code: "PT409", hint: "exists" } }).session,
      ).create(T, SCENE),
    ).toEqual({
      status: "exists",
    });
    expect(
      await createTourRepository(
        client({ error: { code: "23514", hint: "incomplete" } }).session,
      ).publish(T, TOUR, 2),
    ).toEqual({
      status: "incomplete",
    });
    expect(
      await createTourRepository(
        client({ error: { code: "PT409", hint: "media" } }).session,
      ).publish(T, TOUR, 2),
    ).toEqual({
      status: "media",
    });
    expect(
      await createTourRepository(
        client({ error: { code: "PT409", hint: "never_published" } }).session,
      ).discardDraft(T, TOUR, 2),
    ).toEqual({ status: "never_published" });
  });

  it("reads a missing tour as null", async () => {
    expect(
      await createTourRepository(client({ error: { code: "PT404" } }).session).find(T, TOUR),
    ).toBeNull();
  });
});
