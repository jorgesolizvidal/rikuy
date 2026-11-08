import "server-only";

import {
  askCopilotTraced,
  evalFixtureStates,
  fixturesReady,
  openOrganization,
  proposeWithCopilotTraced,
  type Actor,
  type AssistantBatchDeps,
  type CopilotBatchDeps,
  type OrganizationMembership,
  type ProposalTarget,
} from "@rikuy/core";

import { adminSession } from "./admin-session";
import { aiGatewayStatus } from "./ai-gateway";
import { copilotAskDeps, copilotProposeDeps } from "./copilot";
import { askPortalAssistant } from "./portal-assistant";
import { portalTour } from "./portal-content";
import { portalView } from "./portal-view";

/**
 * The evaluation's dependencies (ADR-045). The assistant is asked exactly as a visitor of
 * each demo's portal would (no visitor key: the hourly limit does not apply, the demo's
 * quota does). The Copilot and the trap data use the operator's own session and CURRENT
 * membership in each demo, like any staff member.
 */

/** The spacing is for the provider's tokens per minute: the simulated model has none. */
const wait = (ms: number) =>
  aiGatewayStatus().provider === "simulated"
    ? Promise.resolve()
    : new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The operator's membership in a demo, by its tenant id (null: not a member). */
async function membershipIn(
  actor: Actor,
  tenantId: string,
): Promise<OrganizationMembership | null> {
  const session = await adminSession();
  const tenants = await session.platform.listTenants();
  const slug = tenants.find((tenant) => tenant.tenantId === tenantId)?.slug;
  return slug ? openOrganization(actor, slug, session.memberships) : null;
}

export async function evalFixturesReady(actor: Actor, tenantId: string): Promise<boolean> {
  const membership = await membershipIn(actor, tenantId);
  if (membership === null) return false;
  const session = await adminSession();
  return fixturesReady(await evalFixtureStates(membership, session));
}

export async function assistantBatchDeps(actor: Actor): Promise<AssistantBatchDeps> {
  const session = await adminSession();
  return {
    platform: session.platform,
    evals: session.evals,
    async ask(host, body) {
      const view = await portalView(host);
      if (view === null) throw new Error("portal not found");
      return askPortalAssistant(view, body, null);
    },
    async sampleTour(host) {
      const view = await portalView(host);
      if (view === null) return null;
      const tour = await portalTour(view, "destination", "plaza-principal");
      if (tour === null) return null;
      const { entrySceneId, scenes } = tour.manifest;
      const entry = scenes.find((scene) => scene.sceneId === entrySceneId);
      return {
        entry: entrySceneId,
        second: scenes.find((scene) => scene.sceneId !== entrySceneId)?.sceneId ?? null,
        info: entry?.hotspots.find((hotspot) => hotspot.kind === "info")?.hotspotId ?? null,
      };
    },
    fixturesReady: (tenantId) => evalFixturesReady(actor, tenantId),
    wait,
  };
}

export async function copilotBatchDeps(actor: Actor): Promise<CopilotBatchDeps> {
  const session = await adminSession();
  return {
    platform: session.platform,
    evals: session.evals,
    membership: (tenantId) => membershipIn(actor, tenantId),
    async ask(membership, question) {
      return askCopilotTraced(
        membership,
        actor.userId,
        { question, history: [] },
        await copilotAskDeps(membership),
      );
    },
    async propose(membership, input) {
      return proposeWithCopilotTraced(
        membership,
        actor.userId,
        { target: input.target, fields: input.fields, style: input.style, words: input.words },
        await copilotProposeDeps(),
      );
    },
    proposal: (membership, id) => session.copilot.proposal(membership.tenantId, id),
    reject: (membership, id) => session.copilot.reject(membership.tenantId, id),
    async target(membership, target): Promise<ProposalTarget | null> {
      const snapshot = await session.copilot.snapshot(membership.tenantId);
      if (target.kind === "scene") {
        const plaza = snapshot.items.find(
          (item) => item.kind === "destination" && item.slug === "plaza-principal",
        );
        const tourId = plaza?.tour?.tourId;
        if (!tourId) return null;
        const record = await session.tours.find(membership.tenantId, tourId);
        const revision = record?.draft ?? record?.published;
        const sceneId = revision?.entrySceneId ?? revision?.scenes[0]?.sceneId ?? null;
        return sceneId ? { type: "scene", tourId, sceneId } : null;
      }
      const item = snapshot.items.find(
        (entry) => entry.kind === target.kind && entry.slug === target.slug,
      );
      return item ? { type: "content", contentId: item.contentId } : null;
    },
    async state(membership) {
      const [destinations, events, knowledge, snapshot] = await Promise.all([
        session.content.listDestinations(membership.tenantId),
        session.content.listEvents(membership.tenantId),
        session.knowledge.list(membership.tenantId),
        session.copilot.snapshot(membership.tenantId),
      ]);
      return JSON.stringify([
        destinations.map((row) => [row.slug, row.status, row.publishedAt, row.updatedAt]),
        events.map((row) => [row.slug, row.status, row.publishedAt, row.updatedAt]),
        knowledge.map((row) => [row.slug, row.status, row.publishedAt, row.updatedAt]),
        snapshot.items.map((row) => [row.contentId, row.tour?.status ?? null]),
      ]);
    },
    fixturesReady: (tenantId) => evalFixturesReady(actor, tenantId),
    wait,
  };
}
