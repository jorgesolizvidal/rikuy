import { describe, expect, it } from "vitest";

import {
  emptyDestinationDocument,
  publicationIssues,
  validateDestinationDocument,
  type DestinationDocument,
} from "../../contracts/destination";
import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import {
  createDestination,
  discardDestinationDraft,
  loadDestinationEditor,
  publishDestination,
  restoreDestinationRevision,
  saveDestinationDraft,
  suggestContentSlug,
} from "./destinations";
import type { ContentRepository, DestinationRecord } from "./ports";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const CONTENT = "5eed4100-0000-4000-8000-000000000001";
const IMAGE = "5eed4000-0000-4000-8000-000000000009";

const member = (role: MembershipRole): OrganizationMembership => ({
  tenantId: TENANT,
  slug: "demo-norte",
  displayName: "Municipio Demo Norte",
  role,
  tenantStatus: "active",
});

const complete: DestinationDocument = {
  title: "Mirador del Valle",
  summary: "Vista del valle al atardecer.",
  body: [{ type: "paragraph", children: [{ type: "text", text: "Un mirador." }] }],
  location: { lat: -17.3901, lng: -66.1502 },
  cover: { assetId: IMAGE, version: 1, alt: "El valle desde el mirador" },
  gallery: [{ assetId: IMAGE, version: 1, alt: "Repetida a propósito" }],
};

function repository(overrides: Partial<ContentRepository> = {}) {
  const calls: string[] = [];
  const repo: ContentRepository = {
    listDestinations: async () => [],
    async createDestination(_tenant, slug, title) {
      calls.push(`create:${slug}:${title}`);
      return { status: "created", contentId: CONTENT };
    },
    findDestination: async () => null,
    revisionDocument: async () => null,
    async saveDraft(_tenant, _content, document, expected) {
      calls.push(`save:${expected}:${document.title}`);
      return { status: "saved", revisionNo: 3, editCount: (expected ?? 0) + 1 };
    },
    async publish(_tenant, _content, expected) {
      calls.push(`publish:${expected}`);
      return { status: "published", revisionNo: 3 };
    },
    async restore(_tenant, _content, revision) {
      calls.push(`restore:${revision}`);
      return { status: "restored", revisionNo: 1 };
    },
    async discardDraft(_tenant, _content, expected) {
      calls.push(`discard:${expected}`);
      return { status: "discarded" };
    },
    ...overrides,
  };
  return { repo, calls };
}

const imagePublisher = (published: string[]) => ({
  publish: async (_tenant: string, asset: string, version: number, files: readonly string[]) => {
    published.push(`${asset}/${version}:${files.join(",")}`);
  },
});

describe("destination document", () => {
  it("accepts a complete destination and requires summary and location to publish", () => {
    const valid = validateDestinationDocument(complete);
    expect(valid.ok).toBe(true);
    expect(publicationIssues(emptyDestinationDocument("Plaza"))).toEqual([
      { path: "summary", code: "required" },
      { path: "location", code: "required" },
    ]);
  });

  it("refuses URLs instead of image references, missing alt text and impossible places", () => {
    for (const change of [
      { cover: { assetId: "https://evil.test/x.jpg", version: 1, alt: "x" } },
      { cover: { assetId: IMAGE, version: 1, alt: "" } },
      { location: { lat: 91, lng: 0 } },
      { location: { lat: Number.NaN, lng: 0 } },
      { title: "Línea\nrota" },
      { gallery: Array.from({ length: 31 }, () => complete.cover) },
      { script: "<script>" },
    ]) {
      expect(validateDestinationDocument({ ...complete, ...change }).ok).toBe(false);
    }
  });
});

describe("creating destinations", () => {
  it("suggests the identifier from the title", async () => {
    const { repo, calls } = repository();
    expect(
      await createDestination(
        member("editor"),
        { title: "  Mirador del Valle (Ñuflo) ", slug: "" },
        repo,
      ),
    ).toEqual({ status: "created", contentId: CONTENT });
    expect(calls).toEqual(["create:mirador-del-valle-nuflo:Mirador del Valle (Ñuflo)"]);
    expect(suggestContentSlug("x".repeat(100))).toHaveLength(80);
  });

  it("validates before writing and keeps analysts out", async () => {
    const { repo, calls } = repository();
    expect(await createDestination(member("editor"), { title: "", slug: "" }, repo)).toEqual({
      status: "invalid",
      field: "title",
    });
    expect(
      await createDestination(member("editor"), { title: "Plaza", slug: "Plaza Mayor" }, repo),
    ).toEqual({
      status: "invalid",
      field: "slug",
    });
    expect(await createDestination(member("analyst"), { title: "Plaza", slug: "" }, repo)).toEqual({
      status: "forbidden",
    });
    expect(calls).toEqual([]);
  });
});

describe("editing and publishing", () => {
  it("editors save drafts but cannot publish or roll back", async () => {
    const { repo, calls } = repository();
    expect(await saveDestinationDraft(member("editor"), CONTENT, complete, 2, repo)).toEqual({
      status: "saved",
      revisionNo: 3,
      editCount: 3,
    });
    expect(
      await publishDestination(member("editor"), CONTENT, complete, 3, repo, imagePublisher([])),
    ).toEqual({
      status: "forbidden",
    });
    expect(await restoreDestinationRevision(member("editor"), CONTENT, "r1", repo)).toEqual({
      status: "forbidden",
    });
    expect(calls).toEqual(["save:2:Mirador del Valle"]);
  });

  it("publishing saves the draft, publishes each image once, then the revision", async () => {
    const { repo, calls } = repository();
    const published: string[] = [];
    expect(
      await publishDestination(
        member("owner"),
        CONTENT,
        complete,
        4,
        repo,
        imagePublisher(published),
      ),
    ).toEqual({ status: "published", revisionNo: 3 });
    expect(calls).toEqual(["save:4:Mirador del Valle", "publish:5"]);
    expect(published).toEqual([`${IMAGE}/1:w480.webp,w960.webp,w1600.webp`]);
  });

  it("does not touch images or the public version when the draft is incomplete or stale", async () => {
    const published: string[] = [];
    const incomplete = repository();
    expect(
      await publishDestination(
        member("admin"),
        CONTENT,
        { ...complete, location: null },
        1,
        incomplete.repo,
        imagePublisher(published),
      ),
    ).toEqual({ status: "invalid", issues: [{ path: "location", code: "required" }] });
    expect(incomplete.calls).toEqual([]);

    const stale = repository({ saveDraft: async () => ({ status: "conflict" }) });
    expect(
      await publishDestination(
        member("admin"),
        CONTENT,
        complete,
        1,
        stale.repo,
        imagePublisher(published),
      ),
    ).toEqual({ status: "conflict" });
    expect(stale.calls).toEqual([]);
    expect(published).toEqual([]);
  });

  it("explains database refusals about images", async () => {
    const { repo } = repository({
      saveDraft: async () => ({ status: "invalid", reason: "media" }),
    });
    expect(await saveDestinationDraft(member("editor"), CONTENT, complete, 1, repo)).toEqual({
      status: "invalid",
      issues: [{ path: "images", code: "media" }],
    });
  });

  it("rolls back and discards through the repository", async () => {
    const { repo, calls } = repository();
    expect(await restoreDestinationRevision(member("admin"), CONTENT, "rev-1", repo)).toEqual({
      status: "restored",
      revisionNo: 1,
    });
    expect(await discardDestinationDraft(member("editor"), CONTENT, 2, repo)).toEqual({
      status: "discarded",
    });
    expect(await discardDestinationDraft(member("editor"), CONTENT, "2", repo)).toEqual({
      status: "conflict",
    });
    expect(calls).toEqual(["restore:rev-1", "discard:2"]);
  });
});

describe("editor state", () => {
  const record = (overrides: Partial<DestinationRecord>): DestinationRecord => ({
    contentId: CONTENT,
    tenantId: TENANT,
    slug: "mirador-del-valle",
    draft: null,
    published: null,
    history: [],
    ...overrides,
  });

  it("starts from the open draft, else from the published revision", async () => {
    const draft = { ...complete, title: "Borrador" };
    const withDraft = repository({
      findDestination: async () =>
        record({
          draft: { revisionId: "d", revisionNo: 3, editCount: 7, updatedAt: "", document: draft },
          published: { revisionId: "p", revisionNo: 2, document: complete },
        }),
    });
    expect(await loadDestinationEditor(member("editor"), CONTENT, withDraft.repo)).toMatchObject({
      document: { title: "Borrador" },
      editCount: 7,
      canEdit: true,
      canPublish: false,
    });

    const publishedOnly = repository({
      findDestination: async () =>
        record({ published: { revisionId: "p", revisionNo: 2, document: complete } }),
    });
    expect(await loadDestinationEditor(member("owner"), CONTENT, publishedOnly.repo)).toMatchObject(
      {
        document: { title: "Mirador del Valle" },
        editCount: null,
        canPublish: true,
      },
    );
    expect(await loadDestinationEditor(member("owner"), CONTENT, repository().repo)).toBeNull();
  });
});
