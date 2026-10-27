"use server";

import {
  addTourHotspot,
  addTourScene,
  changeTourScene,
  createTour,
  discardTourDraft,
  openOrganization,
  publishTour,
  removeTourHotspot,
  restoreTourRevision,
  saveGeneralTour,
  updateTourHotspot,
  updateTourScene,
  type CreateTourOutcome,
  type HotspotEditResult,
  type HotspotKind,
  type DiscardTourOutcome,
  type OrganizationMembership,
  type PublishTourOutcome,
  type RestoreTourOutcome,
  type SaveGeneralTourOutcome,
  type SceneEditResult,
} from "@rikuy/core";

import { adminSession, currentAdminActor } from "@/server/admin-session";
import { mediaAdmin } from "@/server/media-admin";
import { refreshPortal } from "@/server/portal-cache";

/**
 * Tour editing (P4 · Paso 1). Each action is one intent with the draft's edit number;
 * the browser refreshes the page with what the database now holds. No redirect() here
 * (CONTRIBUTING §1.2): the action returns its state and the browser navigates.
 */

type SessionProblem = { readonly status: "signed_out" | "error" };

async function membershipFor(
  slug: unknown,
): Promise<OrganizationMembership | "signed_out" | "forbidden"> {
  const actor = await currentAdminActor();
  if (actor === null) return "signed_out";
  const membership =
    typeof slug === "string"
      ? await openOrganization(actor, slug, (await adminSession()).memberships)
      : null;
  return membership ?? "forbidden";
}

async function run<T extends { readonly status: string }>(
  slug: unknown,
  body: (membership: OrganizationMembership) => Promise<T>,
): Promise<T | SessionProblem | { readonly status: "forbidden" }> {
  try {
    const membership = await membershipFor(slug);
    if (membership === "signed_out") return { status: "signed_out" };
    if (membership === "forbidden") return { status: "forbidden" };
    return await body(membership);
  } catch {
    return { status: "error" };
  }
}

export type CreateTourState = CreateTourOutcome | SessionProblem | { readonly status: "idle" };

export async function createTourAction(
  _previous: CreateTourState,
  form: FormData,
): Promise<CreateTourState> {
  return run(form.get("org"), async (membership) =>
    createTour(membership, form.get("contentId"), (await adminSession()).tours),
  );
}

export type SceneEditState = SceneEditResult | SessionProblem;

export interface SceneTarget {
  readonly tourId: string;
  readonly expectedEdit: number | null;
}

export async function addSceneAction(
  slug: string,
  target: SceneTarget,
  scene: { readonly panoramaVersionId: string; readonly title: string },
): Promise<SceneEditState> {
  return run(slug, async (membership) =>
    addTourScene(
      membership,
      { ...target, panoramaVersionId: scene.panoramaVersionId, title: scene.title },
      (await adminSession()).tours,
    ),
  );
}

export async function updateSceneAction(
  slug: string,
  target: SceneTarget & { readonly sceneId: string },
  changes: Readonly<Record<string, unknown>>,
): Promise<SceneEditState> {
  return run(slug, async (membership) =>
    updateTourScene(
      membership,
      { ...target, changes: changes ?? {} },
      (await adminSession()).tours,
    ),
  );
}

export async function changeSceneAction(
  slug: string,
  target: SceneTarget & { readonly sceneId: string },
  intent:
    | { readonly kind: "move"; readonly position: number }
    | { readonly kind: "remove" }
    | { readonly kind: "entry" },
): Promise<SceneEditState> {
  return run(slug, async (membership) =>
    changeTourScene(membership, target, intent, (await adminSession()).tours),
  );
}

export type PublishTourState = PublishTourOutcome | SessionProblem;

export async function publishTourAction(
  slug: string,
  target: { readonly tourId: string; readonly expectedEdit: number | null },
): Promise<PublishTourState> {
  return run(slug, async (membership) => {
    const session = await adminSession();
    // Copies the tour's media to the public bucket, then seals it (ADR-030).
    const result = await publishTour(membership, target, {
      tours: session.tours,
      media: mediaAdmin(),
    });
    if (result.status === "published") {
      await refreshPortal(
        (tenantId) => session.content.portalHostname(tenantId),
        membership.tenantId,
      );
    }
    return result;
  });
}

export type RestoreTourState = RestoreTourOutcome | SessionProblem;

export async function restoreTourAction(
  slug: string,
  target: { readonly tourId: string; readonly revisionId: string },
): Promise<RestoreTourState> {
  return run(slug, async (membership) => {
    const session = await adminSession();
    const result = await restoreTourRevision(membership, target, session.tours);
    if (result.status === "restored") {
      await refreshPortal(
        (tenantId) => session.content.portalHostname(tenantId),
        membership.tenantId,
      );
    }
    return result;
  });
}

export type DiscardTourState = DiscardTourOutcome | SessionProblem;

export async function discardTourDraftAction(
  slug: string,
  target: { readonly tourId: string; readonly expectedEdit: number | null },
): Promise<DiscardTourState> {
  return run(slug, async (membership) =>
    discardTourDraft(membership, target, (await adminSession()).tours),
  );
}

export type HotspotEditState = HotspotEditResult | SessionProblem;

export async function addHotspotAction(
  slug: string,
  target: SceneTarget & { readonly sceneId: string },
  hotspot: Readonly<Record<string, unknown>>,
): Promise<HotspotEditState> {
  return run(slug, async (membership) =>
    addTourHotspot(membership, { ...target, hotspot: hotspot ?? {} }, (await adminSession()).tours),
  );
}

export async function updateHotspotAction(
  slug: string,
  target: SceneTarget & { readonly hotspotId: string; readonly kind: HotspotKind },
  changes: Readonly<Record<string, unknown>>,
): Promise<HotspotEditState> {
  return run(slug, async (membership) =>
    updateTourHotspot(
      membership,
      { ...target, changes: changes ?? {} },
      (await adminSession()).tours,
    ),
  );
}

export async function removeHotspotAction(
  slug: string,
  target: SceneTarget & { readonly hotspotId: string },
): Promise<HotspotEditState> {
  return run(slug, async (membership) =>
    removeTourHotspot(membership, target, (await adminSession()).tours),
  );
}

export type SaveGeneralTourState = SaveGeneralTourOutcome | SessionProblem;

/** The general tour's order and start (P4 · Paso 5): public at once, so the portal refreshes. */
export async function saveGeneralTourAction(
  slug: string,
  input: {
    readonly expectedEdit: number;
    readonly order: readonly string[];
    readonly startTourId: string | null;
  },
): Promise<SaveGeneralTourState> {
  return run(slug, async (membership) => {
    const session = await adminSession();
    const result = await saveGeneralTour(membership, input, { general: session.general });
    if (result.status === "saved") {
      await refreshPortal(
        (tenantId) => session.content.portalHostname(tenantId),
        membership.tenantId,
      );
    }
    return result;
  });
}
