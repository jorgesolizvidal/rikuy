"use server";

import {
  acceptProposal,
  askCopilot,
  openOrganization,
  withModule,
  proposalTargetFromQuery,
  proposeWithCopilot,
  rejectProposal,
  type CopilotAnswer,
  type OrganizationMembership,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { copilotAskDeps, copilotProposeDeps } from "@/server/copilot";

/*
 * The staff's Copilot (ADR-042). Every action re-opens the organization with the CURRENT
 * membership, calls one use case and returns state; the browser navigates by itself (no
 * redirects inside Server Actions, CONTRIBUTING §1.2). The model never decides the
 * municipality nor the permissions: they come from the session, and every write is an RPC
 * that checks them again.
 */

type SessionProblem = { readonly status: "signed_out" | "forbidden" };

async function context(
  slug: unknown,
): Promise<{ membership: OrganizationMembership; actorId: string } | SessionProblem> {
  const actor = await currentAdminActor();
  if (actor === null) return { status: "signed_out" };
  const session = await adminSession();
  const membership =
    typeof slug === "string"
      ? withModule(await openOrganization(actor, slug, session.memberships), "copilot")
      : null;
  return membership === null ? { status: "forbidden" } : { membership, actorId: actor.userId };
}

// ── V1: questions ───────────────────────────────────────────────────────────

export type AskCopilotState = CopilotAnswer | SessionProblem | { readonly status: "error" };

export async function askCopilotAction(input: {
  readonly org: string;
  readonly question: string;
  readonly history: readonly { readonly role: string; readonly text: string }[];
}): Promise<AskCopilotState> {
  try {
    const access = await context(input.org);
    if (!("membership" in access)) return access;
    return await askCopilot(
      access.membership,
      access.actorId,
      { question: input.question, history: input.history },
      await copilotAskDeps(access.membership),
    );
  } catch {
    return { status: "error" };
  }
}

// ── V2: proposals ───────────────────────────────────────────────────────────

export interface ProposeState {
  readonly status:
    | "idle"
    | "created"
    | "notice"
    | "invalid"
    | "stale"
    | "not_found"
    | "forbidden"
    | "signed_out"
    | "error";
  readonly proposalId?: string;
  readonly message?: string;
}

export async function proposeAction(
  _previous: ProposeState,
  formData: FormData,
): Promise<ProposeState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const target = proposalTargetFromQuery({
      contenido: formData.get("contenido") ?? undefined,
      tour: formData.get("tour") ?? undefined,
      escena: formData.get("escena") ?? undefined,
    });
    if (!target) return { status: "not_found" };
    const result = await proposeWithCopilot(
      access.membership,
      access.actorId,
      {
        target,
        fields: formData.getAll("fields"),
        style: formData.get("style"),
        words: formData.get("words") ?? "",
      },
      await copilotProposeDeps(),
    );
    return result.status === "created"
      ? { status: "created", proposalId: result.proposalId }
      : result.status === "notice"
        ? { status: "notice", message: result.message }
        : { status: result.status };
  } catch {
    return { status: "error" };
  }
}

export interface DecideState {
  readonly status:
    | "idle"
    | "accepted"
    | "rejected"
    | "stale"
    | "expired"
    | "decided"
    | "invalid"
    | "not_found"
    | "forbidden"
    | "signed_out"
    | "error";
}

export async function acceptProposalAction(
  _previous: DecideState,
  formData: FormData,
): Promise<DecideState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const session = await adminSession();
    const result = await acceptProposal(
      access.membership,
      { proposalId: formData.get("proposal"), fields: formData.getAll("fields") },
      session.copilot,
    );
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}

export async function rejectProposalAction(
  _previous: DecideState,
  formData: FormData,
): Promise<DecideState> {
  try {
    const access = await context(formData.get("org"));
    if (!("membership" in access)) return access;
    const session = await adminSession();
    const result = await rejectProposal(
      access.membership,
      formData.get("proposal"),
      session.copilot,
    );
    return { status: result.status };
  } catch {
    return { status: "error" };
  }
}
