import { describe, expect, it, vi } from "vitest";

import type { KnowledgeDocument, KnowledgePassage } from "../../contracts/knowledge";
import type { OrganizationMembership } from "../../contracts/organization";
import type { MediaRepository } from "../media/ports";
import { checkDeclaredDocument, extractDocumentText, requestDocumentUpload } from "./documents";
import { buildIndexChunks, parseIndexSource } from "./indexing";
import {
  knowledgePublicationIssues,
  loadKnowledgeEditor,
  publishKnowledge,
  retireKnowledge,
} from "./knowledge";
import type { KnowledgeRepository, PdfTextReader } from "./ports";
import { loadKnowledgeOverview, publicCitation, searchKnowledge } from "./search";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const member = (role: OrganizationMembership["role"]): OrganizationMembership =>
  ({ tenantId: TENANT, role }) as OrganizationMembership;

const pdfReader = (result: Awaited<ReturnType<PdfTextReader["read"]>>): PdfTextReader => ({
  read: vi.fn(async () => result),
});
const PDF = new TextEncoder().encode("%PDF-1.4 …");

describe("documents", () => {
  it("accepts only PDF and text up to 20 MB as declared", () => {
    expect(checkDeclaredDocument("application/pdf", 1000)).toBeNull();
    expect(checkDeclaredDocument("text/plain", 20 * 1024 * 1024)).toBeNull();
    expect(checkDeclaredDocument("application/msword", 1000)).toBe("not_a_document");
    expect(checkDeclaredDocument("text/plain", 20 * 1024 * 1024 + 1)).toBe("too_heavy");
    expect(checkDeclaredDocument("text/plain", 0)).toBe("unreadable");
  });

  it("reserves a document version for editors, never for analysts", async () => {
    const media = {
      createImageUpload: vi.fn(async () => ({
        status: "created" as const,
        upload: { assetId: "a", versionId: "v", version: 1, originalPath: "t/a/1/original" },
      })),
      signedUploadUrl: vi.fn(async () => "https://upload"),
    } as unknown as MediaRepository;
    expect(
      await requestDocumentUpload(member("analyst"), { mime: "text/plain", bytes: 10 }, media),
    ).toEqual({ status: "forbidden" });
    expect(
      await requestDocumentUpload(member("editor"), { mime: "text/plain", bytes: 10 }, media),
    ).toMatchObject({ status: "upload", versionId: "v", assetId: "a", version: 1 });
    expect(media.createImageUpload).toHaveBeenCalledWith(TENANT, "document", "text/plain", 10);
  });

  it("reads a PDF by its bytes, page by page", async () => {
    const pages = [
      { page: 1, text: "Primera página con bastante texto para contar como texto real." },
      { page: 2, text: "Segunda página con bastante texto para contar como texto real." },
    ];
    const result = await extractDocumentText(PDF, pdfReader({ status: "ok", pages }));
    expect(result).toMatchObject({
      status: "ok",
      mime: "application/pdf",
      manifest: { format: "pdf", pages: 2, encoding: "pdf", textFile: "document/text.json" },
      text: { version: 1, pages },
    });
  });

  it("refuses a scanned PDF, a protected one and a damaged one", async () => {
    const empty = Array.from({ length: 10 }, (_, index) => ({ page: index + 1, text: " 3 " }));
    expect(await extractDocumentText(PDF, pdfReader({ status: "ok", pages: empty }))).toEqual({
      status: "rejected",
      problem: "no_text",
    });
    expect(await extractDocumentText(PDF, pdfReader({ status: "encrypted" }))).toEqual({
      status: "rejected",
      problem: "encrypted",
    });
    expect(await extractDocumentText(PDF, pdfReader({ status: "unreadable" }))).toEqual({
      status: "rejected",
      problem: "unreadable",
    });
  });

  it("reads a text file in Windows-1252 and refuses a binary one named .txt", async () => {
    const latin = new Uint8Array([...new TextEncoder().encode("Ucure"), 0xf1, 0x61]);
    const pdf = pdfReader({ status: "unreadable" });
    expect(await extractDocumentText(latin, pdf)).toMatchObject({
      status: "ok",
      mime: "text/plain",
      manifest: { format: "txt", pages: null, encoding: "windows-1252", characters: 7 },
    });
    expect(await extractDocumentText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]), pdf)).toEqual({
      status: "rejected",
      problem: "not_a_document",
    });
    expect(pdf.read).not.toHaveBeenCalled();
  });
});

describe("the editor", () => {
  const document: KnowledgeDocument = { title: "Libro", summary: "", body: [], document: null };

  it("needs text or a document to publish", () => {
    expect(knowledgePublicationIssues(document)).toEqual([{ path: "body", code: "required" }]);
    expect(
      knowledgePublicationIssues({ ...document, document: { assetId: TENANT, version: 1 } }),
    ).toEqual([]);
  });

  it("only owners and admins publish and retire", async () => {
    const repository = { retire: vi.fn() } as unknown as KnowledgeRepository;
    expect(await publishKnowledge(member("editor"), "c", document, 1, repository)).toEqual({
      status: "forbidden",
    });
    expect(await retireKnowledge(member("editor"), "c", repository)).toEqual({
      status: "forbidden",
    });
    expect(repository.retire).not.toHaveBeenCalled();
  });

  it("shows a retired item with its last version", async () => {
    const repository = {
      find: vi.fn(async () => ({
        contentId: "c",
        tenantId: TENANT,
        slug: "libro",
        draft: null,
        published: null,
        history: [{ revisionId: "r2", revisionNo: 2, title: "Libro", sealedAt: "x" }],
      })),
      revisionDocument: vi.fn(async () => document),
    } as unknown as KnowledgeRepository;
    const editor = await loadKnowledgeEditor(member("owner"), "c", repository);
    expect(editor).toMatchObject({ retired: true, document, attachment: null });
    expect(repository.revisionDocument).toHaveBeenCalledWith(TENANT, "r2");
  });
});

describe("search", () => {
  const passage: KnowledgePassage = {
    chunkId: "c1",
    source: "tour",
    sourceId: "t1",
    sourceVersion: 1,
    kind: "destination",
    slug: "museo historico",
    title: "Museo",
    heading: "Sala principal",
    text: "…",
    pages: null,
    sceneId: "00000000-0000-4000-8000-000000000001",
    hotspotId: null,
    ended: false,
    score: 1,
  };

  it("refuses empty or overlong questions and trims the rest", async () => {
    const repository = { search: vi.fn(async () => [passage]) } as unknown as KnowledgeRepository;
    expect(await searchKnowledge(member("analyst"), " ", repository)).toEqual({
      status: "invalid",
    });
    expect(await searchKnowledge(member("analyst"), "a".repeat(301), repository)).toEqual({
      status: "invalid",
    });
    expect(await searchKnowledge(member("analyst"), "  ¿qué  hay?  ", repository)).toEqual({
      status: "ok",
      query: "¿qué hay?",
      passages: [passage],
    });
    expect(repository.search).toHaveBeenCalledWith(TENANT, "¿qué hay?", 8);
  });

  it("cites a tour on its scene, a destination by its page and a document without a link", () => {
    expect(publicCitation(passage)).toEqual({
      title: "Museo · Sala principal",
      label: "Tour 360°",
      href: "/destinos/museo%20historico/tour?escena=00000000-0000-4000-8000-000000000001",
      page: null,
      ended: false,
    });
    expect(publicCitation({ ...passage, source: "content", heading: null })).toMatchObject({
      label: "Destino",
      href: "/destinos/museo%20historico",
    });
    expect(
      publicCitation({
        ...passage,
        source: "content",
        kind: "knowledge",
        heading: "Capítulo 2",
        pages: { from: 14, to: 15 },
      }),
    ).toEqual({
      title: "Museo · Capítulo 2",
      label: "Documento",
      href: null,
      page: "págs. 14–15",
      ended: false,
    });
  });

  it("summarizes what is indexed, pending and failed", async () => {
    const entry = {
      source: "content",
      sourceId: "s",
      kind: "destination",
      slug: "x",
      title: "X",
      revisionNo: 1,
      publishedAt: "",
    };
    const repository = {
      indexStatus: vi.fn(async () => [
        { ...entry, chunks: 3, indexedAt: "", job: null },
        { ...entry, chunks: null, indexedAt: null, job: { status: "pending", errorCode: null } },
        { ...entry, chunks: null, indexedAt: null, job: { status: "dead_letter", errorCode: "x" } },
      ]),
    } as unknown as KnowledgeRepository;
    expect(await loadKnowledgeOverview(member("analyst"), repository)).toMatchObject({
      indexed: 1,
      pending: 1,
      failed: 1,
      chunks: 3,
    });
  });
});

describe("indexing", () => {
  it("validates what the database describes and hashes every fragment", async () => {
    expect(parseIndexSource({ status: "not_found" })).toBeNull();
    const source = parseIndexSource({
      status: "ok",
      source: "content",
      kind: "knowledge",
      slug: "libro",
      revisionNo: 1,
      title: "Libro",
      summary: "",
      body: [],
      timezone: "America/La_Paz",
      schedule: null,
      venueTitle: null,
      document: {
        prefix: "t/a/1/",
        manifest: {
          version: 1,
          format: "txt",
          pages: null,
          characters: 10,
          textFile: "document/text.json",
          encoding: "utf-8",
        },
      },
    });
    expect(source).not.toBeNull();
    if (!source) return;
    const readText = vi.fn(async () => ({
      version: 1 as const,
      pages: [{ page: null, text: "Hola." }],
    }));
    const built = await buildIndexChunks(source, readText);
    expect(readText).toHaveBeenCalledWith("t/a/1/");
    expect(built.chunkerVersion).toBe(1);
    expect(built.chunks).toEqual([
      expect.objectContaining({ body: "Hola.", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
    ]);
    await expect(buildIndexChunks(source, async () => null)).rejects.toThrow();
  });
});
