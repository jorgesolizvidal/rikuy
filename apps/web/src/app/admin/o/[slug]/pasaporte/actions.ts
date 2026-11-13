"use server";

import {
  createCircuit,
  deleteCircuit,
  openOrganization,
  publishCircuit,
  saveCircuit,
  withdrawCircuit,
  type CircuitWriteOutcome,
  type CreateCircuitOutcome,
  type DeleteCircuitOutcome,
  type OrganizationMembership,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { refreshPortal } from "@/server/portal-cache";

/**
 * The tourist passport's circuits (C2 · Paso 1, ADR-056). Each action re-opens the
 * organization with the CURRENT membership, calls one use case and returns its state; the
 * browser refreshes or navigates by itself (no redirect() here, CONTRIBUTING §1.2).
 */

type SessionProblem = { readonly status: "signed_out" | "error" };

async function run<T extends { readonly status: string }>(
  slug: unknown,
  body: (membership: OrganizationMembership) => Promise<T>,
): Promise<T | SessionProblem | { readonly status: "forbidden" }> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out" };
    const membership =
      typeof slug === "string"
        ? await openOrganization(actor, slug, (await adminSession()).memberships)
        : null;
    if (membership === null) return { status: "forbidden" };
    return await body(membership);
  } catch {
    return { status: "error" };
  }
}

/** Publishing, withdrawing or changing a published circuit: visitors see it at once. */
async function refresh(membership: OrganizationMembership): Promise<void> {
  const session = await adminSession();
  await refreshPortal((tenantId) => session.content.portalHostname(tenantId), membership.tenantId);
}

export type CreateCircuitState =
  CreateCircuitOutcome | SessionProblem | { readonly status: "idle" };

export async function createCircuitAction(
  _previous: CreateCircuitState,
  form: FormData,
): Promise<CreateCircuitState> {
  return run(form.get("org"), async (membership) =>
    createCircuit(membership, (await adminSession()).passport, {
      slug: form.get("slug"),
      name: form.get("name"),
    }),
  );
}

export type CircuitWriteState = CircuitWriteOutcome | SessionProblem;

export async function saveCircuitAction(
  org: string,
  input: {
    readonly circuitId: string;
    readonly editNo: number;
    readonly name: string;
    readonly summary: string;
    readonly reward: string;
    readonly stops: readonly string[];
    readonly published: boolean;
  },
): Promise<CircuitWriteState> {
  return run(org, async (membership) => {
    const result = await saveCircuit(membership, (await adminSession()).passport, input);
    if (result.status === "saved" && input.published) await refresh(membership);
    return result;
  });
}

export async function publishCircuitAction(
  org: string,
  circuitId: string,
  editNo: number,
): Promise<CircuitWriteState> {
  return run(org, async (membership) => {
    const result = await publishCircuit(
      membership,
      (await adminSession()).passport,
      circuitId,
      editNo,
    );
    if (result.status === "saved") await refresh(membership);
    return result;
  });
}

export async function withdrawCircuitAction(
  org: string,
  circuitId: string,
  editNo: number,
): Promise<CircuitWriteState> {
  return run(org, async (membership) => {
    const result = await withdrawCircuit(
      membership,
      (await adminSession()).passport,
      circuitId,
      editNo,
    );
    if (result.status === "saved") await refresh(membership);
    return result;
  });
}

export type DeleteCircuitState = DeleteCircuitOutcome | SessionProblem;

export async function deleteCircuitAction(
  org: string,
  circuitId: string,
  editNo: number,
): Promise<DeleteCircuitState> {
  return run(org, async (membership) =>
    deleteCircuit(membership, (await adminSession()).passport, circuitId, editNo),
  );
}
