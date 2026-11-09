"use server";

import {
  finishEvaluation,
  openOrganization,
  PORTAL_PATHS,
  prepareEvalFixtures,
  rateEvaluationAnswer,
  retireEvalFixtures,
  runAssistantBatch,
  runCopilotBatch,
  startEvaluation,
  TRAP_EVENT,
  type BatchResult,
  type EvalSuite,
  type StartEvaluationResult,
} from "@rikuy/core";
import { revalidatePath } from "next/cache";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { aiGatewayStatus } from "@/server/ai-gateway";
import { assistantBatchDeps, copilotBatchDeps } from "@/server/evaluation";
import { mediaAdmin } from "@/server/media-admin";
import { refreshPortal } from "@/server/portal-cache";

/*
 * «Evaluar el asistente» and «Evaluar el Copilot» (ADR-045). Every action is for an operator
 * with a second factor (the use cases and the RPCs check it again), returns state and lets
 * the browser refresh by itself (no redirects inside Server Actions, CONTRIBUTING §1.2).
 */

type Problem = { readonly status: "signed_out" | "error" };

const suiteOf = (value: unknown): EvalSuite | null =>
  value === "assistant" || value === "copilot" ? value : null;

export async function startEvaluationAction(input: {
  readonly suite: string;
  readonly tenantA: string;
  readonly tenantB: string;
  readonly scope?: string;
}): Promise<StartEvaluationResult | Problem> {
  try {
    if ((await currentAdminActor()) === null) return { status: "signed_out" };
    const session = await adminSession();
    const status = aiGatewayStatus();
    return await startEvaluation(input, {
      platform: session.platform,
      evals: session.evals,
      model:
        status.configured && status.provider && status.model
          ? { provider: status.provider, model: status.model }
          : null,
    });
  } catch {
    return { status: "error" };
  }
}

export async function runBatchAction(input: {
  readonly suite: string;
  readonly runId: string;
}): Promise<BatchResult | Problem> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out" };
    const suite = suiteOf(input.suite);
    if (suite === null) return { status: "error" };
    return suite === "assistant"
      ? await runAssistantBatch({ runId: input.runId }, await assistantBatchDeps(actor))
      : await runCopilotBatch({ runId: input.runId }, await copilotBatchDeps(actor));
  } catch {
    return { status: "error" };
  }
}

export async function rateAnswerAction(input: {
  readonly runId: string;
  readonly caseId: string;
  readonly repetition: number;
  readonly rating: number | null;
}): Promise<{ readonly status: string }> {
  try {
    if ((await currentAdminActor()) === null) return { status: "signed_out" };
    const session = await adminSession();
    return {
      status: await rateEvaluationAnswer(input, {
        platform: session.platform,
        evals: session.evals,
      }),
    };
  } catch {
    return { status: "error" };
  }
}

export async function finishEvaluationAction(runId: string): Promise<{ readonly status: string }> {
  try {
    if ((await currentAdminActor()) === null) return { status: "signed_out" };
    const session = await adminSession();
    return {
      status: await finishEvaluation(runId, { platform: session.platform, evals: session.evals }),
    };
  } catch {
    return { status: "error" };
  }
}

/** The demo's portal pages, and the trap event's (which leaves every listing). */
async function refreshDemo(tenantId: string): Promise<void> {
  const session = await adminSession();
  await refreshPortal((id) => session.content.portalHostname(id), tenantId);
  try {
    const hostname = await session.content.portalHostname(tenantId);
    if (hostname) {
      revalidatePath(
        `/portal/${encodeURIComponent(hostname)}${PORTAL_PATHS.event(TRAP_EVENT.slug)}`,
      );
    }
  } catch {
    // The page also expires on its own.
  }
}

export async function prepareFixturesAction(
  tenantId: string,
): Promise<{ readonly status: string }> {
  try {
    const actor = await currentAdminActor();
    if (actor === null) return { status: "signed_out" };
    const session = await adminSession();
    if ((await session.platform.operatorAccess()) !== "ok") return { status: "forbidden" };
    const slug = (await session.platform.listTenants()).find(
      (tenant) => tenant.tenantId === tenantId,
    )?.slug;
    const membership = slug ? await openOrganization(actor, slug, session.memberships) : null;
    if (membership === null) return { status: "not_member" };
    const prepared = await prepareEvalFixtures(membership, {
      content: session.content,
      knowledge: session.knowledge,
      admin: mediaAdmin(),
      now: () => new Date(),
    });
    if (prepared.status === "prepared") await refreshDemo(tenantId);
    return { status: prepared.status };
  } catch {
    return { status: "error" };
  }
}

export async function retireFixturesAction(tenantId: string): Promise<{ readonly status: string }> {
  try {
    if ((await currentAdminActor()) === null) return { status: "signed_out" };
    const session = await adminSession();
    const retired = await retireEvalFixtures(tenantId, {
      platform: session.platform,
      evals: session.evals,
    });
    if (retired.status === "retired") await refreshDemo(tenantId);
    return { status: retired.status };
  } catch {
    return { status: "error" };
  }
}
