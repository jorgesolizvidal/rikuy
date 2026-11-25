import { describe, expect, it, vi } from "vitest";

import type { KnowledgePassage } from "../../contracts/knowledge";
import type { OrganizationMembership } from "../../contracts/organization";
import {
  emptyStoryDocument,
  storyPublicationIssues,
  storyTeller,
  validateStoryDocument,
  type PublishedStory,
} from "../../contracts/story";
import { passageHeader } from "../../domain/assistant/prompts";
import { contentUnits } from "../../domain/knowledge/sources";
import { checkModuleSet, MODULE_PACKAGES, passageVisibleWith } from "../../domain/tenancy/modules";
import { buildSitemap } from "../content/portal";
import { publicCitation } from "../knowledge/search";
import type { StoryRepository } from "./ports";
import { listStories, publishStory, retireStory, saveStoryDraft, storiesOfPlace } from "./stories";

const member = (role: OrganizationMembership["role"]): OrganizationMembership =>
  ({ tenantId: "t1", role }) as OrganizationMembership;

const PLACE = "11111111-2222-4333-8444-555555555555";

const doc = (changes: Record<string, unknown> = {}) => ({
  ...emptyStoryDocument("La noche de la helada"),
  summary: "Cómo se salvó la cosecha del 63.",
  body: [{ type: "paragraph", children: [{ type: "text", text: "Mi abuelo encendió fogatas." }] }],
  author: "Doña Rosa Vargas",
  community: "Vecina de la plaza",
  placeId: PLACE,
  consent: true,
  ...changes,
});

function repository(overrides: Partial<StoryRepository> = {}): StoryRepository {
  return {
    list: vi.fn(async () => []),
    places: vi.fn(async () => []),
    create: vi.fn(),
    find: vi.fn(),
    revisionDocument: vi.fn(),
    saveDraft: vi.fn(async () => ({ status: "saved" as const, revisionNo: 1, editCount: 2 })),
    publish: vi.fn(async () => ({ status: "published" as const, revisionNo: 1 })),
    retire: vi.fn(async () => ({ status: "retired" as const })),
    restore: vi.fn(),
    discardDraft: vi.fn(),
    ...overrides,
  } as StoryRepository;
}

const issues = (input: unknown) => {
  const result = validateStoryDocument(input);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};

describe("a story's document", () => {
  it("accepts who tells it, their community, its place and the consent", () => {
    expect(validateStoryDocument(doc()).ok).toBe(true);
    expect(validateStoryDocument(doc({ placeId: null, community: "" })).ok).toBe(true);
  });

  it("keeps no name when it is anonymous", () => {
    const result = validateStoryDocument(doc({ anonymous: true }));
    expect(result.ok && result.value.author).toBe("");
  });

  it("refuses a name of several lines, a place that is not an id, a consent that is not a yes or no and other keys", () => {
    expect(issues(doc({ author: "Rosa\nVargas" }))).toEqual(["author"]);
    expect(issues(doc({ placeId: "plaza" }))).toEqual(["placeId"]);
    expect(issues(doc({ consent: "sí" }))).toEqual(["consent"]);
    expect(issues(doc({ location: null }))).toEqual([""]);
  });

  it("needs its text, who tells it and the person's consent to be published", () => {
    expect(storyPublicationIssues(doc() as never)).toEqual([]);
    expect(
      storyPublicationIssues(doc({ body: [], author: "", consent: false }) as never).map(
        (issue) => issue.path,
      ),
    ).toEqual(["body", "author", "consent"]);
    expect(storyPublicationIssues(doc({ author: "", anonymous: true }) as never)).toEqual([]);
  });

  it("names who tells it, or «Anónimo»", () => {
    expect(storyTeller({ author: "Doña Rosa", anonymous: false })).toBe("Doña Rosa");
    expect(storyTeller({ author: null, anonymous: true })).toBe("Anónimo");
    expect(storyTeller({ author: "Doña Rosa", anonymous: true })).toBe("Anónimo");
  });
});

describe("the editors' use cases", () => {
  it("an editor saves, an analyst cannot", async () => {
    const repo = repository();
    expect((await saveStoryDraft(member("editor"), "s1", doc(), 1, repo)).status).toBe("saved");
    expect((await saveStoryDraft(member("analyst"), "s1", doc(), 1, repo)).status).toBe(
      "forbidden",
    );
    expect(repo.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("a place the database refuses is pointed at the place field", async () => {
    const repo = repository({
      saveDraft: vi.fn(async () => ({ status: "invalid" as const, reason: "place" as const })),
    });
    expect(await saveStoryDraft(member("editor"), "s1", doc(), 1, repo)).toEqual({
      status: "invalid",
      issues: [{ path: "placeId", code: "invalid" }],
    });
  });

  it("only owners and admins publish and retire", async () => {
    const repo = repository();
    expect((await publishStory(member("editor"), "s1", doc(), 1, repo)).status).toBe("forbidden");
    expect((await retireStory(member("editor"), "s1", repo)).status).toBe("forbidden");
    expect((await publishStory(member("admin"), "s1", doc(), 1, repo)).status).toBe("published");
    expect((await retireStory(member("owner"), "s1", repo)).status).toBe("retired");
    expect(repo.publish).toHaveBeenCalledWith("t1", "s1", 2);
  });

  it("without consent it says so before touching the database", async () => {
    const repo = repository();
    expect(await publishStory(member("owner"), "s1", doc({ consent: false }), 1, repo)).toEqual({
      status: "invalid",
      issues: [{ path: "consent", code: "required" }],
    });
    expect(repo.saveDraft).not.toHaveBeenCalled();
  });

  it("the database's own refusal of consent is shown on the consent box", async () => {
    const repo = repository({
      publish: vi.fn(async () => ({ status: "invalid" as const, reason: "consent" as const })),
    });
    expect(await publishStory(member("owner"), "s1", doc(), 1, repo)).toEqual({
      status: "invalid",
      issues: [{ path: "consent", code: "required" }],
    });
  });

  it("lists published first, then drafts and retired ones", async () => {
    const entry = (title: string, status: "draft" | "published" | "retired") => ({
      contentId: title,
      slug: title,
      title,
      teller: null,
      status,
      updatedAt: "",
      publishedAt: null,
    });
    const repo = repository({
      list: vi.fn(async () => [
        entry("c", "retired"),
        entry("b", "draft"),
        entry("a", "published"),
      ]),
    });
    expect((await listStories(member("analyst"), repo)).map((story) => story.title)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("what visitors and the assistant get", () => {
  const story = (slug: string, place: string | null): PublishedStory => ({
    slug,
    title: slug,
    summary: "",
    body: [],
    author: "Doña Rosa",
    anonymous: false,
    community: null,
    place: place ? { slug: place, title: place } : null,
    publishedAt: "2026-11-25T00:00:00Z",
  });

  it("a destination's page shows only its own stories", () => {
    expect(
      storiesOfPlace([story("a", "plaza"), story("b", null), story("c", "mirador")], "plaza").map(
        (s) => s.slug,
      ),
    ).toEqual(["a"]);
  });

  const source = {
    source: "content" as const,
    kind: "story" as const,
    slug: "la-helada",
    revisionNo: 1,
    title: "La noche de la helada",
    summary: "",
    body: [],
    timezone: "America/La_Paz",
    schedule: null,
    venueTitle: null,
    hours: null,
    validity: null,
    placeTitle: "Plaza principal",
    service: null,
    story: { author: "Doña Rosa Vargas", anonymous: false, community: "Vecina de la plaza" },
    document: null,
  };

  it("every passage says whose story it is and its place", () => {
    const text = JSON.stringify(contentUnits(source, null)[0]?.blocks);
    expect(text).toContain("Relato de Doña Rosa Vargas (Vecina de la plaza).");
    expect(text).toContain("Lugar: Plaza principal.");
    const anonymous = JSON.stringify(
      contentUnits(
        { ...source, story: { author: null, anonymous: true, community: null } },
        null,
      )[0]?.blocks,
    );
    expect(anonymous).toContain("Relato anónimo de la comunidad.");
  });

  const passage = {
    chunkId: "c1",
    source: "content",
    sourceId: "s1",
    sourceVersion: 1,
    kind: "story",
    slug: "la-helada",
    title: "La noche de la helada",
    heading: null,
    text: "Relato de Doña Rosa Vargas.",
    pages: null,
    sceneId: null,
    hotspotId: null,
    ended: false,
    score: 1,
  } satisfies KnowledgePassage;

  it("the model reads it as a story of the community, and the citation leads to /memoria", () => {
    expect(passageHeader(passage)).toBe("Relato de la comunidad «La noche de la helada»");
    expect(publicCitation(passage)).toMatchObject({ label: "Relato", href: "/memoria#la-helada" });
  });

  it("the module hides its passages and is part of both packages", () => {
    expect(passageVisibleWith(["assistant"], { source: "content", kind: "story" })).toBe(false);
    expect(
      passageVisibleWith(["assistant", "community_memory"], { source: "content", kind: "story" }),
    ).toBe(true);
    expect(MODULE_PACKAGES.information).toContain("community_memory");
    expect(checkModuleSet(["community_memory"]).status).toBe("ok");
  });

  it("the sitemap lists /memoria only with published stories", () => {
    expect(buildSitemap("https://demo.example", [])).not.toContain("/memoria");
    expect(buildSitemap("https://demo.example", [], [], [], [], { memory: true })).toContain(
      "<loc>https://demo.example/memoria</loc>",
    );
  });
});
