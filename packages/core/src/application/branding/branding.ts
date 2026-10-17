import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import {
  defaultPresentation,
  parseStoredPresentation,
  PRESENTATION_SCHEMA_VERSION,
  validatePresentation,
  type PresentationIssue,
  type TenantPresentation,
} from "../../contracts/presentation";
import type { PortalTenant } from "../../contracts/tenant";
import { deriveTheme, type ThemePalette } from "../../domain/branding/theme";
import type {
  PublishedPresentationReader,
  PublishOutcome,
  SaveDraftOutcome,
  TenantConfigRepository,
} from "./ports";

const BRANDING_MANAGERS: readonly MembershipRole[] = ["owner", "admin"];

/** Owners and administrators manage the portal brand; editors and analysts can only view it. */
export function canManageBranding(role: MembershipRole): boolean {
  return BRANDING_MANAGERS.includes(role);
}

export interface BrandingEditorState {
  readonly canEdit: boolean;
  /** What the form starts with: the open draft, else the published version, else defaults. */
  readonly initial: TenantPresentation;
  readonly draft: {
    readonly configId: string;
    readonly revision: number;
    readonly updatedAt: string;
  } | null;
  readonly published: { readonly version: number; readonly sealedAt: string } | null;
  readonly portalHostname: string | null;
}

export async function loadBrandingEditor(
  membership: OrganizationMembership,
  repository: TenantConfigRepository,
): Promise<BrandingEditorState> {
  const snapshot = await repository.loadSnapshot(membership.tenantId);
  const draft = snapshot.draft ? parseStoredPresentation(snapshot.draft.presentation) : null;
  const published = snapshot.published
    ? parseStoredPresentation(snapshot.published.presentation)
    : null;

  return {
    canEdit: canManageBranding(membership.role),
    initial: draft ?? published ?? defaultPresentation(membership),
    draft: snapshot.draft
      ? {
          configId: snapshot.draft.configId,
          revision: snapshot.draft.revision,
          updatedAt: snapshot.draft.updatedAt,
        }
      : null,
    published: snapshot.published
      ? { version: snapshot.published.version, sealedAt: snapshot.published.sealedAt }
      : null,
    portalHostname: snapshot.portalHostname,
  };
}

export type SaveBrandingResult =
  | Exclude<SaveDraftOutcome, { status: "invalid" }>
  | { readonly status: "invalid"; readonly issues: readonly PresentationIssue[] };

/** Validates (shape + contrast) and stores the tenant's single draft. */
export async function saveBrandingDraft(
  membership: OrganizationMembership,
  input: unknown,
  expectedRevision: number | null,
  repository: TenantConfigRepository,
): Promise<SaveBrandingResult> {
  if (!canManageBranding(membership.role)) return { status: "forbidden" };
  const validation = validatePresentation(input);
  if (!validation.ok) return { status: "invalid", issues: validation.issues };

  const outcome = await repository.saveDraft(
    membership.tenantId,
    validation.value,
    expectedRevision,
  );
  return outcome.status === "invalid" ? { status: "invalid", issues: [] } : outcome;
}

export type PublishBrandingResult =
  | Exclude<PublishOutcome, { status: "invalid" }>
  | { readonly status: "invalid"; readonly issues: readonly PresentationIssue[] };

/**
 * Saves the submitted values as the draft and publishes it. Publishing itself (seal the
 * version, move the tenant's active pointer, write the audit event) is one transaction.
 */
export async function publishBranding(
  membership: OrganizationMembership,
  input: unknown,
  expectedRevision: number | null,
  repository: TenantConfigRepository,
): Promise<PublishBrandingResult> {
  const saved = await saveBrandingDraft(membership, input, expectedRevision, repository);
  if (saved.status !== "saved") return saved;

  const outcome = await repository.publish(membership.tenantId, saved.configId, saved.revision);
  return outcome.status === "invalid" ? { status: "invalid", issues: [] } : outcome;
}

export interface ResolvedPresentation {
  readonly presentation: TenantPresentation;
  readonly palette: ThemePalette;
  /** Sealed configuration id, or null when defaults are used. Part of every cache key. */
  readonly configId: string | null;
  readonly source: "published" | "default";
}

function fromDefaults(tenant: PortalTenant): ResolvedPresentation {
  const presentation = defaultPresentation(tenant);
  return {
    presentation,
    palette: deriveTheme(presentation.theme),
    configId: null,
    source: "default",
  };
}

/**
 * Presentation for a public portal request. Degrades to the neutral default (never to
 * another tenant's brand) when nothing is published, the stored value is unreadable or
 * the read fails: branding must not take a portal down.
 */
export async function resolvePortalPresentation(
  tenant: PortalTenant,
  reader: PublishedPresentationReader,
): Promise<ResolvedPresentation> {
  if (tenant.activeConfigId === null) return fromDefaults(tenant);

  let record;
  try {
    record = await reader.findPublished(tenant.activeConfigId);
  } catch {
    return fromDefaults(tenant);
  }
  if (record === null || record.schemaVersion !== PRESENTATION_SCHEMA_VERSION) {
    return fromDefaults(tenant);
  }

  const presentation = parseStoredPresentation(record.presentation);
  if (presentation === null) return fromDefaults(tenant);

  return {
    presentation,
    palette: deriveTheme(presentation.theme),
    configId: tenant.activeConfigId,
    source: "published",
  };
}
