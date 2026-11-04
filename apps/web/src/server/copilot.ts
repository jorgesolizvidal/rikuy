import "server-only";

import {
  loadAiUsage,
  loadUsage,
  usageLines,
  type CopilotAiRunner,
  type CopilotAskDeps,
  type CopilotProposeDeps,
  type OrganizationMembership,
} from "@rikuy/core";

import { adminSession } from "./admin-session";
import { runAiWork } from "./ai-gateway";

/**
 * The Copilot's dependencies (ADR-042): every read and write with the signed-in person's
 * session (RLS and the RPCs' role checks), and the model only through the AI gateway, with
 * the municipality's quota and the person as the request's actor.
 */

const ai: CopilotAiRunner = (input, work) => runAiWork(input, work);

export async function copilotAskDeps(membership: OrganizationMembership): Promise<CopilotAskDeps> {
  const session = await adminSession();
  return {
    copilot: session.copilot,
    knowledge: session.knowledge,
    async usage() {
      const [meters, aiUsage] = await Promise.all([
        loadUsage(membership, session.usage),
        loadAiUsage(membership, session.aiUsage).catch(() => null),
      ]);
      return usageLines({
        meters,
        ai: aiUsage
          ? { used: aiUsage.meter.consumed + aiUsage.meter.reserved, limit: aiUsage.meter.limit }
          : null,
      });
    },
    ai,
  };
}

export async function copilotProposeDeps(): Promise<CopilotProposeDeps> {
  const session = await adminSession();
  return {
    copilot: session.copilot,
    content: session.content,
    tours: session.tours,
    knowledge: session.knowledge,
    ai,
  };
}
