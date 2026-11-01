import {
  DOCUMENT_MIMES,
  DOCUMENT_RULES,
  DOCUMENT_TEXT_FILE,
  type DocumentManifest,
  type DocumentMime,
  type DocumentProblem,
  type DocumentText,
} from "../../contracts/knowledge";
import type { OrganizationMembership } from "../../contracts/organization";
import type { UsageResource } from "../../contracts/usage";
import { decodeTextFile, splitTextPages, textCharacters } from "../../domain/knowledge/text";
import { canEditContent } from "../content/editing";
import type { MediaRepository } from "../media/ports";
import type { DocumentSubmitOutcome, KnowledgeRepository, PdfTextReader } from "./ports";

export type RequestDocumentUploadResult =
  | {
      readonly status: "upload";
      readonly versionId: string;
      readonly assetId: string;
      readonly version: number;
      readonly uploadUrl: string;
      readonly mime: DocumentMime;
    }
  | { readonly status: "invalid"; readonly problem: DocumentProblem }
  | { readonly status: "forbidden" | "rate_limited" }
  | { readonly status: "over_quota"; readonly resource: UsageResource };

/** What the browser says it sends: a PDF or a text file, at most 20 MB. */
export function checkDeclaredDocument(mime: unknown, bytes: unknown): DocumentProblem | null {
  if (typeof mime !== "string" || !(DOCUMENT_MIMES as readonly string[]).includes(mime)) {
    return "not_a_document";
  }
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) return "unreadable";
  if (bytes > DOCUMENT_RULES.maxBytes) return "too_heavy";
  return null;
}

/** Step 1: reserve a document version and hand the browser a one-time upload URL. */
export async function requestDocumentUpload(
  membership: OrganizationMembership,
  input: { readonly mime: unknown; readonly bytes: unknown },
  media: MediaRepository,
): Promise<RequestDocumentUploadResult> {
  if (!canEditContent(membership.role)) return { status: "forbidden" };
  const problem = checkDeclaredDocument(input.mime, input.bytes);
  if (problem !== null) return { status: "invalid", problem };

  const mime = input.mime as DocumentMime;
  const created = await media.createImageUpload(
    membership.tenantId,
    "document",
    mime,
    input.bytes as number,
  );
  if (created.status === "invalid") return { status: "invalid", problem: "too_heavy" };
  if (created.status === "over_quota") return created;
  if (created.status !== "created") return { status: created.status };
  return {
    status: "upload",
    versionId: created.upload.versionId,
    assetId: created.upload.assetId,
    version: created.upload.version,
    uploadUrl: await media.signedUploadUrl(created.upload.originalPath),
    mime,
  };
}

/** Step 2: the upload finished; the text is read in the background (a durable job). */
export async function submitDocument(
  membership: OrganizationMembership,
  versionId: unknown,
  knowledge: KnowledgeRepository,
): Promise<DocumentSubmitOutcome> {
  if (!canEditContent(membership.role)) return "forbidden";
  if (typeof versionId !== "string" || !/^[0-9a-f-]{36}$/u.test(versionId)) return "not_found";
  return knowledge.submitDocument(membership.tenantId, versionId);
}

export type ExtractedDocument =
  | {
      readonly status: "ok";
      readonly mime: DocumentMime;
      readonly text: DocumentText;
      readonly manifest: DocumentManifest;
    }
  | { readonly status: "rejected"; readonly problem: DocumentProblem };

const PDF_MAGIC = "%PDF-";

/**
 * Reads a document's real bytes (never the declared type): a PDF with text, page by page,
 * or a text file (UTF-8 or Windows-1252), with its printed page marks when it has them.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  pdf: PdfTextReader,
): Promise<ExtractedDocument> {
  if (bytes.byteLength > DOCUMENT_RULES.maxBytes)
    return { status: "rejected", problem: "too_heavy" };
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  const isPdf = head.includes(PDF_MAGIC);

  let pages: DocumentText["pages"];
  let encoding: DocumentManifest["encoding"];
  let pageCount: number | null;
  if (isPdf) {
    const read = await pdf.read(bytes, { maxPages: DOCUMENT_RULES.maxPages });
    if (read.status !== "ok") return { status: "rejected", problem: read.status };
    pages = read.pages.map((page) => ({ page: page.page, text: page.text }));
    encoding = "pdf";
    pageCount = pages.length;
    // A scan has (almost) no text: most pages below the minimum.
    const withText = pages.filter(
      (page) => page.text.replace(/\s+/gu, "").length >= DOCUMENT_RULES.minCharactersPerPage,
    ).length;
    if (pages.length === 0 || withText < Math.max(1, pages.length * 0.2)) {
      return { status: "rejected", problem: "no_text" };
    }
  } else {
    const decoded = decodeTextFile(bytes);
    if (decoded === null) return { status: "rejected", problem: "not_a_document" };
    pages = splitTextPages(decoded.text);
    encoding = decoded.encoding;
    const numbered = pages.filter((page) => page.page !== null);
    pageCount = numbered.length > 0 ? Math.min(numbered.length, DOCUMENT_RULES.maxPages) : null;
    if (pages.length > DOCUMENT_RULES.maxPages)
      return { status: "rejected", problem: "too_many_pages" };
  }

  const characters = textCharacters(pages);
  if (characters === 0) return { status: "rejected", problem: "no_text" };
  if (characters > DOCUMENT_RULES.maxCharacters) return { status: "rejected", problem: "too_long" };

  return {
    status: "ok",
    mime: isPdf ? "application/pdf" : "text/plain",
    text: { version: 1, pages },
    manifest: {
      version: 1,
      format: isPdf ? "pdf" : "txt",
      pages: pageCount,
      characters,
      textFile: DOCUMENT_TEXT_FILE,
      encoding,
    },
  };
}

/** Why a document was refused, in words for the editor. */
export const DOCUMENT_PROBLEM_TEXT: Readonly<Record<DocumentProblem, string>> = {
  not_a_document: "No es un PDF ni un archivo de texto (.txt).",
  too_heavy: "Pesa más de 20 MB.",
  unreadable: "El archivo está dañado o no se pudo leer.",
  encrypted: "El PDF está protegido con contraseña. Guárdalo sin contraseña y vuelve a subirlo.",
  no_text:
    "El documento no tiene texto que se pueda leer (parece escaneado o son imágenes). Sube un PDF con texto o un .txt.",
  too_many_pages: "Tiene más de 2.000 páginas.",
  too_long: "Tiene más de 5 millones de caracteres de texto.",
};
