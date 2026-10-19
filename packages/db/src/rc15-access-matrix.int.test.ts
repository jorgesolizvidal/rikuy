/**
 * RC-15 · access matrix against a REAL local Supabase stack, through the same Data API, RPCs
 * and Storage that the app uses (not the UI). Each actor tries the same operations on Demo
 * Norte's private data; nobody outside Demo Norte — another municipality's owner, a revoked
 * member, a visitor — gets anything, and inside it each role gets exactly what it should.
 *
 * Writes use a stale edit count: an allowed role is stopped by the concurrency check
 * (PT409) after passing authorization, a forbidden one by authorization itself (42501).
 * Nothing in the seed changes.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { env, signIn, stackAvailable, USERS } from "./integration/local-stack";

const NORTE = "5eed1000-0000-4000-8000-000000000001";
/** «Feria de los domingos»: a destination of Demo Norte that was never published. */
const DRAFT_ITEM = "5eed4100-0000-4000-8000-000000000002";
const DRAFT_REVISION = "5eed4200-0000-4000-8000-000000000003";
const VALID_DOCUMENT = {
  title: "Feria de los domingos",
  summary: "",
  body: [],
  location: null,
  cover: null,
  gallery: [],
};
const STALE = 999_999;

type Actor = "owner" | "editor" | "revoked" | "otherOwner" | "visitor";
const ACTORS: readonly Actor[] = ["owner", "editor", "revoked", "otherOwner", "visitor"];
/** The ones that must never see or touch anything private of Demo Norte. */
const OUTSIDERS: readonly Actor[] = ["revoked", "otherOwner", "visitor"];

/** "rows:N", or the error code when the request is refused. */
async function rows(
  query: PromiseLike<{ data: unknown[] | null; error: { code?: string } | null }>,
) {
  const { data, error } = await query;
  return error ? (error.code ?? "error") : `rows:${data?.length ?? 0}`;
}

async function code(query: PromiseLike<{ error: { code?: string } | null }>) {
  const { error } = await query;
  return error ? (error.code ?? "error") : "ok";
}

describe.runIf(stackAvailable)("RC-15 · access matrix (Data API, RPC, Storage)", () => {
  const clients = {} as Record<Actor, SupabaseClient>;
  const userIds = {} as Partial<Record<Actor, string>>;
  let originalPath: string;

  beforeAll(async () => {
    for (const [actor, email] of [
      ["owner", USERS.ownerNorte],
      ["editor", USERS.both], // editor in Norte, analyst in Sur
      ["revoked", USERS.revoked],
      ["otherOwner", USERS.ownerSur],
    ] as const) {
      const session = await signIn(email);
      clients[actor] = session.client;
      userIds[actor] = session.actor.userId;
    }
    clients.visitor = createClient(env.url, env.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // An original image of Demo Norte (uploaded by the earlier integration suites).
    const { data } = await clients.owner
      .from("asset_versions")
      .select("original_path")
      .eq("tenant_id", NORTE)
      .eq("status", "ready")
      .limit(1);
    const found = (data?.[0] as { original_path?: string } | undefined)?.original_path;
    if (!found) throw new Error("no ready image in Demo Norte to test Storage with");
    originalPath = found;
  });

  async function matrix(operation: (client: SupabaseClient) => Promise<string>) {
    const result = {} as Record<Actor, string>;
    for (const actor of ACTORS) result[actor] = await operation(clients[actor]);
    return result;
  }

  const empty = (value: string) => value === "rows:0" || value === "42501";

  it("draft revisions: only current members of the municipality read them", async () => {
    const result = await matrix((client) =>
      rows(client.from("content_revisions").select("id, title").eq("id", DRAFT_REVISION)),
    );
    expect(result.owner).toBe("rows:1");
    expect(result.editor).toBe("rows:1");
    for (const actor of OUTSIDERS)
      expect(empty(result[actor]), `${actor}: ${result[actor]}`).toBe(true);
  });

  it("content items, configuration drafts and audit: nothing for outsiders", async () => {
    for (const table of ["content_items", "tenant_config_versions", "audit_events"]) {
      const result = await matrix((client) =>
        rows(client.from(table).select("tenant_id").eq("tenant_id", NORTE)),
      );
      expect(result.owner, table).not.toBe("rows:0");
      for (const actor of OUTSIDERS) {
        expect(empty(result[actor]), `${table} · ${actor}: ${result[actor]}`).toBe(true);
      }
    }
  });

  it("memberships: outsiders see nobody else's; a revoked member only their own, revoked", async () => {
    const others = await matrix((client) => {
      const actor = ACTORS.find((name) => clients[name] === client);
      const own = actor ? userIds[actor] : undefined;
      const query = client.from("memberships").select("user_id").eq("tenant_id", NORTE);
      return rows(own ? query.neq("user_id", own) : query);
    });
    expect(others.owner).not.toBe("rows:0");
    for (const actor of OUTSIDERS) {
      expect(empty(others[actor]), `memberships · ${actor}: ${others[actor]}`).toBe(true);
    }
    const { data } = await clients.revoked
      .from("memberships")
      .select("status")
      .eq("tenant_id", NORTE);
    expect(data).toEqual([{ status: "revoked" }]);
  });

  it("saving a draft: owner and editor pass authorization, outsiders are refused", async () => {
    const result = await matrix((client) =>
      code(
        client.rpc("save_content_draft", {
          p_tenant_id: NORTE,
          p_content_id: DRAFT_ITEM,
          p_document: VALID_DOCUMENT,
          p_expected_edit: STALE,
        }),
      ),
    );
    expect(result).toEqual({
      owner: "PT409",
      editor: "PT409",
      revoked: "42501",
      otherOwner: "42501",
      visitor: "42501",
    });
  });

  it("publishing: only owners and admins; an editor is refused", async () => {
    const result = await matrix((client) =>
      code(
        client.rpc("publish_content", {
          p_tenant_id: NORTE,
          p_content_id: DRAFT_ITEM,
          p_expected_edit: STALE,
        }),
      ),
    );
    expect(result).toEqual({
      owner: "PT409",
      editor: "42501",
      revoked: "42501",
      otherOwner: "42501",
      visitor: "42501",
    });
  });

  it("the member list: owners and admins only", async () => {
    const result = await matrix((client) =>
      code(client.rpc("list_tenant_members", { p_tenant_id: NORTE })),
    );
    expect(result).toEqual({
      owner: "ok",
      editor: "42501",
      revoked: "42501",
      otherOwner: "42501",
      visitor: "42501",
    });
  });

  it("the portal never serves a draft, to anyone", async () => {
    const result = await matrix(async (client) => {
      const { data, error } = await client.rpc("portal_destination", {
        p_tenant_id: NORTE,
        p_slug: "feria-de-los-domingos",
      });
      if (error) return error.code ?? "error";
      return Array.isArray(data) ? `rows:${data.length}` : data ? "rows:1" : "rows:0";
    });
    for (const actor of ACTORS) expect(result[actor], actor).toBe("rows:0");
  });

  it("original images in Storage: members sign them, nobody else", async () => {
    const result = await matrix(async (client) => {
      const { data, error } = await client.storage
        .from("media-originals")
        .createSignedUrl(originalPath, 60);
      return error || !data?.signedUrl ? "refused" : "signed";
    });
    expect(result).toEqual({
      owner: "signed",
      editor: "signed",
      revoked: "refused",
      otherOwner: "refused",
      visitor: "refused",
    });
  });
});
