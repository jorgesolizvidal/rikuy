import { describe, expect, it } from "vitest";

import { createMediaRepository } from "./media";
import { createMediaLibraryRepository } from "./media-library";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ASSET = "5eed3000-0000-4000-8000-000000000001";
const VERSION = "5eed3100-0000-4000-8000-000000000002";
const TOUR = "5eed6000-0000-4000-8000-000000000001";
const CONTENT = "5eed4100-0000-4000-8000-000000000001";

function client(route: (url: URL, body: unknown) => Response) {
  const calls: { path: string; body: unknown }[] = [];
  const session = createSessionClient({
    url: BASE,
    publishableKey: "sb_publishable_test",
    secureCookies: false,
    cookies: { getAll: () => [], setAll: () => undefined },
    fetch: async (input, init = {}) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: url.pathname, body });
      return route(url, body);
    },
  });
  return { session, calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

describe("media library (ADR-048)", () => {
  it("reads where each panorama is used, and nothing before the migration", async () => {
    const { session, calls } = client(() =>
      json([
        {
          asset_id: ASSET,
          tour_id: TOUR,
          content_id: CONTENT,
          content_kind: "destination",
          content_title: "Museo",
          scope: "published",
          working: true,
          version: 1,
        },
      ]),
    );
    expect(await createMediaLibraryRepository(session).uses(TENANT, "panorama")).toEqual([
      {
        assetId: ASSET,
        tourId: TOUR,
        contentId: CONTENT,
        contentKind: "destination",
        contentTitle: "Museo",
        scope: "published",
        working: true,
        version: 1,
      },
    ]);
    expect(calls[0]?.body).toEqual({ p_tenant_id: TENANT, p_purpose: "panorama" });
    const missing = client(() => pgError("PGRST202", 404));
    expect(await createMediaLibraryRepository(missing.session).uses(TENANT, "model")).toEqual([]);
  });

  it("counts the tours that got the new version", async () => {
    const { session } = client(() =>
      json([
        { tour_id: TOUR, opened_draft: true },
        { tour_id: CONTENT, opened_draft: false },
      ]),
    );
    expect(await createMediaLibraryRepository(session).applyReplacement(TENANT, VERSION)).toEqual({
      status: "applied",
      tours: 2,
      openedDrafts: 1,
    });
  });

  it.each([
    [pgError("PT409", 409, "not_ready"), { status: "not_ready" }],
    [pgError("PT409", 409, "stale"), { status: "stale" }],
    [pgError("42501", 403), { status: "forbidden" }],
    [pgError("PT404", 404), { status: "not_found" }],
  ])("maps refusals to use the new version (%#)", async (response, outcome) => {
    const { session } = client(() => response.clone());
    expect(await createMediaLibraryRepository(session).applyReplacement(TENANT, VERSION)).toEqual(
      outcome,
    );
  });

  it.each([
    [json(1), { status: "deleted" }],
    [pgError("PT409", 409, "in_use"), { status: "in_use" }],
    [pgError("PT409", 409, "busy"), { status: "busy" }],
    [pgError("42501", 403), { status: "forbidden" }],
    [pgError("PT404", 404), { status: "not_found" }],
  ])("maps deletion results (%#)", async (response, outcome) => {
    const { session } = client(() => response.clone());
    expect(await createMediaLibraryRepository(session).deleteAsset(TENANT, ASSET)).toEqual(outcome);
  });

  it.each([
    [
      json([
        {
          asset_id: ASSET,
          version_id: VERSION,
          version: 2,
          original_path: `t/${ASSET}/2/original`,
        },
      ]),
      {
        status: "created",
        upload: {
          assetId: ASSET,
          versionId: VERSION,
          version: 2,
          originalPath: `t/${ASSET}/2/original`,
        },
      },
    ],
    [pgError("PT409", 409, "busy"), { status: "busy" }],
    [pgError("PT404", 404), { status: "not_found" }],
    [pgError("23514", 400), { status: "invalid" }],
    [pgError("PT507", 507, "storage_bytes"), { status: "over_quota", resource: "storage_bytes" }],
  ])("starts a replacement upload (%#)", async (response, outcome) => {
    const { session } = client(() => response.clone());
    expect(
      await createMediaRepository(session).createReplacementUpload(
        TENANT,
        ASSET,
        "image/jpeg",
        1000,
      ),
    ).toEqual(outcome);
  });
});
