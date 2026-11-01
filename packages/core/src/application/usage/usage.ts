import type { OrganizationMembership } from "../../contracts/organization";
import {
  QUOTA_WARNING_SHARE,
  USAGE_RESOURCES,
  type UsageLevel,
  type UsageResource,
  type UsageView,
} from "../../contracts/usage";

/** The municipality's current usage, with the signed-in user's session (any member). */
export interface UsageRepository {
  tenantUsage(tenantId: string): Promise<UsageView[]>;
}

export interface PlatformUsageRow extends UsageView {
  readonly tenantId: string;
  readonly slug: string;
  readonly displayName: string;
  /** No limit assigned to this municipality: the platform default applies. */
  readonly isDefault: boolean;
}

export type SetQuotaOutcome = "changed" | "forbidden" | "not_found" | "invalid";

/** Operator side (second factor checked by the database). */
export interface PlatformUsageRepository {
  list(): Promise<PlatformUsageRow[]>;
  setQuota(tenantId: string, resource: UsageResource, limit: number): Promise<SetQuotaOutcome>;
}

export interface UsageMeter extends UsageView {
  /** consumed + reserved over the limit (0–1, may pass 1 when settling overshot). */
  readonly share: number;
  readonly level: UsageLevel;
  /** What is still available for new work (never negative). */
  readonly available: number;
}

export function meter(view: UsageView): UsageMeter {
  const used = view.consumed + view.reserved;
  const share = view.limit > 0 ? used / view.limit : used > 0 ? Infinity : 0;
  return {
    ...view,
    share,
    level: share >= 1 ? "full" : share >= QUOTA_WARNING_SHARE ? "near" : "ok",
    available: Math.max(0, view.limit - used),
  };
}

export async function loadUsage(
  membership: OrganizationMembership,
  usage: UsageRepository,
): Promise<readonly UsageMeter[]> {
  const views = await usage.tenantUsage(membership.tenantId);
  return USAGE_RESOURCES.flatMap((resource) => {
    const view = views.find((item) => item.resource === resource);
    return view ? [meter(view)] : [];
  });
}

/** Operator input: megabytes for storage, minutes for compute, thousands of tokens for AI. */
export const QUOTA_UNITS: Readonly<
  Record<UsageResource, { readonly factor: number; readonly max: number }>
> = {
  storage_bytes: { factor: 1024 * 1024, max: 1024 * 1024 },
  media_compute_seconds: { factor: 60, max: 100_000 },
  ai_tokens: { factor: 1000, max: 10_000 },
};

export function parseQuotaInput(
  resource: unknown,
  value: unknown,
): { readonly resource: UsageResource; readonly limit: number } | null {
  if (!USAGE_RESOURCES.includes(resource as UsageResource)) return null;
  const unit = QUOTA_UNITS[resource as UsageResource];
  const text = typeof value === "string" ? value.trim().replace(",", ".") : "";
  if (!/^\d{1,7}(\.\d{1,2})?$/u.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > unit.max) return null;
  return { resource: resource as UsageResource, limit: Math.round(amount * unit.factor) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** An operator changes a municipality's limit (the database requires the second factor). */
export async function changeQuota(
  input: { readonly tenantId: unknown; readonly resource: unknown; readonly value: unknown },
  platform: PlatformUsageRepository,
): Promise<SetQuotaOutcome> {
  if (typeof input.tenantId !== "string" || !UUID.test(input.tenantId)) return "not_found";
  const parsed = parseQuotaInput(input.resource, input.value);
  if (parsed === null) return "invalid";
  return platform.setQuota(input.tenantId, parsed.resource, parsed.limit);
}
