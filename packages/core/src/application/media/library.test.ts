import { describe, expect, it } from "vitest";

import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import {
  deleteTourMedia,
  groupMediaVersions,
  latestReadyVersions,
  applyMediaReplacement,
  type MediaLibraryRepository,
  type MediaUse,
  type VersionLike,
} from "./library";
import { requestModelUpload } from "./models";
import { requestPanoramaUpload } from "./panoramas";
import type { MediaRepository } from "./ports";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const A = "5eed3000-0000-4000-8000-00000000000a";
const B = "5eed3000-0000-4000-8000-00000000000b";
const TOUR = "5eed6000-0000-4000-8000-000000000001";
const OTHER_TOUR = "5eed6000-0000-4000-8000-000000000002";
const CONTENT = "5eed4100-0000-4000-8000-000000000001";

const member = (role: MembershipRole): OrganizationMembership => ({
  tenantId: TENANT,
  slug: "demo-norte",
  displayName: "Municipio Demo Norte",
  role,
  tenantStatus: "active",
});

const version = (assetId: string, number: number, status: VersionLike["status"]): VersionLike => ({
  versionId: `${assetId.slice(0, -3)}${number.toString().padStart(3, "0")}`,
  assetId,
  version: number,
  status,
});

const use = (overrides: Partial<MediaUse>): MediaUse => ({
  assetId: A,
  tourId: TOUR,
  contentId: CONTENT,
  contentKind: "destination",
  contentTitle: "Museo",
  scope: "published",
  working: true,
  version: 1,
  ...overrides,
});

describe("grouping versions by panorama or model (ADR-048)", () => {
  it("shows the newest ready version and a replacement on its way", () => {
    const [asset] = groupMediaVersions(
      [version(A, 2, "processing"), version(A, 1, "ready")],
      [use({})],
    );
    expect(asset?.current.version).toBe(1);
    expect(asset?.replacement?.version).toBe(2);
    expect(asset?.deletable).toBe(false);
    expect(asset?.outdatedTours).toBe(0);
  });

  it("tells which tours still use an older version in what they are edited from", () => {
    const [asset] = groupMediaVersions(
      [version(A, 2, "ready"), version(A, 1, "ready")],
      [
        use({ scope: "published", working: true, version: 1 }),
        use({
          tourId: OTHER_TOUR,
          contentTitle: "Feria",
          scope: "draft",
          working: true,
          version: 2,
        }),
        use({
          tourId: OTHER_TOUR,
          contentTitle: "Feria",
          scope: "published",
          working: false,
          version: 1,
        }),
      ],
    );
    expect(asset?.current.version).toBe(2);
    expect(asset?.replacement).toBeNull();
    expect(asset?.outdatedTours).toBe(1);
    expect(
      asset?.tours.map((tour) => [tour.contentTitle, tour.outdated, tour.draft, tour.published]),
    ).toEqual([
      ["Feria", false, true, true],
      ["Museo", true, false, true],
    ]);
  });

  it("a failed replacement leaves the ready version current", () => {
    const [asset] = groupMediaVersions([version(A, 2, "rejected"), version(A, 1, "ready")], []);
    expect(asset?.current.version).toBe(1);
    expect(asset?.replacement?.status).toBe("rejected");
    expect(asset?.deletable).toBe(true);
  });

  it("only what no revision ever used, and nothing in processing, can be deleted", () => {
    const groups = groupMediaVersions(
      [version(B, 1, "processing"), version(A, 1, "ready")],
      [use({ scope: "history", working: false })],
    );
    expect(groups.map((group) => [group.assetId, group.deletable])).toEqual([
      [B, false],
      [A, false],
    ]);
    expect(groups[1]?.tours[0]?.historyOnly).toBe(true);
  });

  it("keeps the order of the list (newest upload first)", () => {
    const groups = groupMediaVersions(
      [version(B, 1, "ready"), version(A, 2, "ready"), version(A, 1, "ready")],
      [],
    );
    expect(groups.map((group) => group.assetId)).toEqual([B, A]);
  });

  it("offers the tour editor only the newest ready version, never of an asset it uses", () => {
    const views = [version(A, 2, "ready"), version(A, 1, "ready"), version(B, 1, "ready")];
    expect(latestReadyVersions(views).map((view) => `${view.assetId}:${view.version}`)).toEqual([
      `${A}:2`,
      `${B}:1`,
    ]);
    expect(latestReadyVersions(views, new Set([A])).map((view) => view.assetId)).toEqual([B]);
    expect(latestReadyVersions([version(A, 2, "processing"), version(A, 1, "ready")])).toEqual([
      version(A, 1, "ready"),
    ]);
  });
});

describe("using a replacement and deleting", () => {
  const library = (calls: string[]): MediaLibraryRepository => ({
    uses: async () => [],
    async applyReplacement(_tenant, versionId) {
      calls.push(`apply:${versionId}`);
      return { status: "applied", tours: 2, openedDrafts: 1 };
    },
    async deleteAsset(_tenant, assetId) {
      calls.push(`delete:${assetId}`);
      return { status: "deleted" };
    },
  });

  it("editors put the new version in the tours; analysts do not", async () => {
    const calls: string[] = [];
    expect(await applyMediaReplacement(member("editor"), A, library(calls))).toEqual({
      status: "applied",
      tours: 2,
      openedDrafts: 1,
    });
    expect(await applyMediaReplacement(member("analyst"), A, library(calls))).toEqual({
      status: "forbidden",
    });
    expect(await applyMediaReplacement(member("owner"), "../x", library(calls))).toEqual({
      status: "not_found",
    });
    expect(calls).toEqual([`apply:${A}`]);
  });

  it("only owners and admins delete", async () => {
    const calls: string[] = [];
    expect(await deleteTourMedia(member("admin"), A, library(calls))).toEqual({
      status: "deleted",
    });
    for (const role of ["editor", "analyst"] as const) {
      expect(await deleteTourMedia(member(role), A, library(calls))).toEqual({
        status: "forbidden",
      });
    }
    expect(await deleteTourMedia(member("owner"), 42, library(calls))).toEqual({
      status: "not_found",
    });
    expect(calls).toEqual([`delete:${A}`]);
  });
});

describe("replacement uploads", () => {
  const media = (calls: string[], outcome: "created" | "busy" | "not_found"): MediaRepository => ({
    createImageUpload: async () => {
      calls.push("new");
      return {
        status: "created",
        upload: { assetId: B, versionId: "v", version: 1, originalPath: "t/b/1/original" },
      };
    },
    createReplacementUpload: async (_tenant, assetId, mime) => {
      calls.push(`replace:${assetId}:${mime}`);
      return outcome === "created"
        ? {
            status: "created",
            upload: {
              assetId,
              versionId: "v2",
              version: 2,
              originalPath: `t/${assetId}/2/original`,
            },
          }
        : { status: outcome };
    },
    signedUploadUrl: async (path) => `https://upload.example.test/${path}`,
    findVersion: async () => null,
    signedPreviewUrl: async () => null,
    signedPreviewUrls: async () => new Map(),
  });

  it("a panorama is replaced by a new version of the same asset", async () => {
    const calls: string[] = [];
    expect(
      await requestPanoramaUpload(
        member("editor"),
        { mime: "image/jpeg", bytes: 1000, replaces: A },
        media(calls, "created"),
      ),
    ).toEqual({
      status: "upload",
      versionId: "v2",
      uploadUrl: `https://upload.example.test/t/${A}/2/original`,
      mime: "image/jpeg",
    });
    expect(calls).toEqual([`replace:${A}:image/jpeg`]);
  });

  it("reports one already on its way, a deleted one and a bad id, before uploading", async () => {
    const calls: string[] = [];
    expect(
      await requestPanoramaUpload(
        member("editor"),
        { mime: "image/jpeg", bytes: 1000, replaces: A },
        media(calls, "busy"),
      ),
    ).toEqual({ status: "busy" });
    expect(
      await requestModelUpload(
        member("editor"),
        { mime: "model/gltf-binary", bytes: 1000, replaces: A },
        media(calls, "not_found"),
      ),
    ).toEqual({ status: "not_found" });
    expect(
      await requestModelUpload(
        member("editor"),
        { mime: "model/gltf-binary", bytes: 1000, replaces: "otro" },
        media(calls, "created"),
      ),
    ).toEqual({ status: "not_found" });
    expect(calls).toEqual([`replace:${A}:image/jpeg`, `replace:${A}:model/gltf-binary`]);
  });
});
