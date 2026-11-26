import type { OrganizationMembership } from "../../contracts/organization";
import { parseEmbedOrigin, parseWebLink } from "../../domain/assistant/embed";
import { canPublishContent } from "../content/editing";

/**
 * «Solo asistente» (A · Paso 2, ADR-071): the websites where a municipality's assistant may
 * be embedded (only the platform operator changes them) and «Página en la web del municipio»
 * of each item (owners and admins). The database checks the same again.
 */

export interface EmbedOriginEntry {
  readonly origin: string;
  readonly createdAt: string;
}

export type EmbedOriginsOutcome =
  | { readonly status: "updated"; readonly origins: readonly string[] }
  | { readonly status: "invalid" | "too_many" | "not_found" | "forbidden" | "error" };

export interface PlatformEmbedRepository {
  /** Null: not the operator with its second factor. */
  list(tenantId: string): Promise<EmbedOriginEntry[] | null>;
  add(tenantId: string, origin: string): Promise<EmbedOriginsOutcome>;
  remove(tenantId: string, origin: string): Promise<EmbedOriginsOutcome>;
}

export type WebLinkOutcome =
  | { readonly status: "saved"; readonly url: string | null }
  | { readonly status: "invalid" | "origin" | "not_found" | "forbidden" | "error" };

export interface EmbedRepository {
  /** The municipality's authorized websites; empty when it has none (or before ADR-071). */
  origins(tenantId: string): Promise<string[]>;
  webLink(tenantId: string, contentId: string): Promise<string | null>;
  setWebLink(tenantId: string, contentId: string, url: string | null): Promise<WebLinkOutcome>;
}

export async function addEmbedOrigin(
  repository: PlatformEmbedRepository,
  tenantId: unknown,
  value: unknown,
): Promise<EmbedOriginsOutcome> {
  if (typeof tenantId !== "string" || tenantId === "") return { status: "invalid" };
  const origin = parseEmbedOrigin(value);
  if (origin === null) return { status: "invalid" };
  return repository.add(tenantId, origin);
}

export async function removeEmbedOrigin(
  repository: PlatformEmbedRepository,
  tenantId: unknown,
  value: unknown,
): Promise<EmbedOriginsOutcome> {
  if (typeof tenantId !== "string" || tenantId === "" || typeof value !== "string") {
    return { status: "invalid" };
  }
  return repository.remove(tenantId, value);
}

export interface ContentWebLink {
  /** The municipality's authorized websites (none: the editor does not offer the field). */
  readonly origins: readonly string[];
  readonly url: string | null;
  /** Owners and admins set it, like the address (ADR-047). */
  readonly canChange: boolean;
}

/** The field in the editor, or null when the municipality has no authorized website. */
export async function loadContentWebLink(
  membership: OrganizationMembership,
  contentId: string,
  repository: Pick<EmbedRepository, "origins" | "webLink">,
): Promise<ContentWebLink | null> {
  const origins = await repository.origins(membership.tenantId);
  if (origins.length === 0) return null;
  return {
    origins,
    url: await repository.webLink(membership.tenantId, contentId),
    canChange: canPublishContent(membership.role),
  };
}

export async function saveContentWebLink(
  membership: OrganizationMembership,
  contentId: unknown,
  value: unknown,
  repository: EmbedRepository,
): Promise<WebLinkOutcome> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  if (typeof contentId !== "string" || contentId === "") return { status: "invalid" };
  const origins = await repository.origins(membership.tenantId);
  const parsed = parseWebLink(value, origins);
  if (parsed.status !== "ok") return parsed;
  return repository.setWebLink(membership.tenantId, contentId, parsed.url);
}
