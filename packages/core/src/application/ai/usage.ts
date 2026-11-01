import type { AiResult, AiUsageView, PlatformAiUsageRow } from "../../contracts/ai";
import type { OrganizationMembership } from "../../contracts/organization";
import { meter, type UsageMeter } from "../usage/usage";
import type { PlatformRepository } from "../platform/ports";
import { PROBE_MESSAGES } from "./simulated";
import type { AiRequestInput } from "./gateway";

/** A municipality's AI usage, with the signed-in user's session (any member). */
export interface AiUsageRepository {
  tenantAiUsage(tenantId: string): Promise<AiUsageView>;
}

/** Every municipality's AI usage; null without access (the database checks the 2nd factor). */
export interface PlatformAiUsageRepository {
  list(): Promise<PlatformAiUsageRow[] | null>;
}

export interface AiUsageMeter {
  readonly meter: UsageMeter;
  readonly answeredToday: number;
  readonly refusedToday: number;
}

function toMeter(view: AiUsageView): AiUsageMeter {
  return {
    meter: meter({
      resource: "ai_tokens",
      limit: view.limit,
      reserved: view.reserved,
      consumed: view.consumed,
      periodStart: view.periodStart,
      periodEnd: view.periodEnd,
    }),
    answeredToday: view.answeredToday,
    refusedToday: view.refusedToday,
  };
}

export async function loadAiUsage(
  membership: OrganizationMembership,
  usage: AiUsageRepository,
): Promise<AiUsageMeter> {
  return toMeter(await usage.tenantAiUsage(membership.tenantId));
}

export interface PlatformAiUsageMeter extends AiUsageMeter {
  readonly row: PlatformAiUsageRow;
}

export async function loadPlatformAiUsage(
  platform: Pick<PlatformRepository, "operatorAccess">,
  usage: PlatformAiUsageRepository,
): Promise<readonly PlatformAiUsageMeter[] | null> {
  if ((await platform.operatorAccess()) !== "ok") return null;
  const rows = await usage.list();
  return rows?.map((row) => ({ row, ...toMeter(row) })) ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type AiProbeOutcome =
  | { readonly status: "forbidden" }
  | { readonly status: "not_found" }
  | { readonly status: "done"; readonly result: AiResult };

/**
 * «Probar la IA» (ADR-036): an operator sends the smallest request through the gateway on
 * behalf of a municipality, to prove the provider key and see the quota at work. Counts
 * against that municipality's quota like any other request.
 */
export async function probeAi(
  input: { readonly tenantId: unknown; readonly actorId: string },
  deps: {
    readonly platform: Pick<PlatformRepository, "operatorAccess" | "listTenants">;
    readonly gateway: (request: AiRequestInput) => Promise<AiResult>;
  },
): Promise<AiProbeOutcome> {
  if ((await deps.platform.operatorAccess()) !== "ok") return { status: "forbidden" };
  if (typeof input.tenantId !== "string" || !UUID.test(input.tenantId))
    return { status: "not_found" };
  const tenants = await deps.platform.listTenants();
  if (!tenants.some((tenant) => tenant.tenantId === input.tenantId)) return { status: "not_found" };
  const result = await deps.gateway({
    tenantId: input.tenantId,
    profile: "probe",
    messages: PROBE_MESSAGES,
    actorId: input.actorId,
  });
  return { status: "done", result };
}
