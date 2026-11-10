import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";

/**
 * Replacing and deleting panoramas and 3D models (ADR-048). A replacement is a new version of
 * the same asset; «use it in the tours» puts it in the draft of each tour that still uses an
 * older one (visitors see it when the tour is published). Only what no tour revision ever
 * used can be deleted, so «Volver a esta versión» always works.
 */

export type TourMediaPurpose = "panorama" | "model";

/** Owners, admins and editors replace and put the new version in the tours. */
export const MEDIA_REPLACERS: readonly MembershipRole[] = ["owner", "admin", "editor"];

/** Only owners and admins delete (it cannot be undone). */
export const MEDIA_DELETERS: readonly MembershipRole[] = ["owner", "admin"];

/** One tour revision that uses a version of the asset. */
export interface MediaUse {
  readonly assetId: string;
  readonly tourId: string;
  readonly contentId: string;
  readonly contentKind: "destination" | "event";
  readonly contentTitle: string;
  /** draft · published · history (an older published version, for «Volver a esta versión»). */
  readonly scope: "draft" | "published" | "history";
  /** The revision the tour is edited from (its draft, else its published version). */
  readonly working: boolean;
  readonly version: number;
}

export type ApplyReplacementOutcome =
  | { readonly status: "applied"; readonly tours: number; readonly openedDrafts: number }
  | { readonly status: "not_ready" | "stale" | "forbidden" | "not_found" };

export type DeleteMediaOutcome =
  | { readonly status: "deleted" }
  | { readonly status: "in_use" | "busy" | "forbidden" | "not_found" };

/** With the signed-in user's session; the database checks role and tenant again. */
export interface MediaLibraryRepository {
  uses(tenantId: string, purpose: TourMediaPurpose): Promise<MediaUse[]>;
  applyReplacement(tenantId: string, versionId: string): Promise<ApplyReplacementOutcome>;
  deleteAsset(tenantId: string, assetId: string): Promise<DeleteMediaOutcome>;
}

/** The fields of a version the grouping needs (panorama and model views have them). */
export interface VersionLike {
  readonly versionId: string;
  readonly assetId: string;
  readonly version: number;
  readonly status: "uploading" | "processing" | "ready" | "rejected";
}

/** How one tour uses the asset, for the panel. */
export interface TourUse {
  readonly tourId: string;
  readonly contentId: string;
  readonly contentKind: "destination" | "event";
  readonly contentTitle: string;
  readonly draft: boolean;
  readonly published: boolean;
  /** Only an older published version uses it. */
  readonly historyOnly: boolean;
  /** Its working revision uses an older version than the current one. */
  readonly outdated: boolean;
}

export interface MediaAsset<V extends VersionLike> {
  readonly assetId: string;
  /** The newest ready version, else the newest one (a first upload still on its way). */
  readonly current: V;
  /** A newer version that is not ready: uploading, processing or rejected. */
  readonly replacement: V | null;
  readonly tours: readonly TourUse[];
  /** Tours whose draft (or published version, without a draft) still uses an older one. */
  readonly outdatedTours: number;
  /** Nothing uses it, nothing is being processed: it can be deleted. */
  readonly deletable: boolean;
}

/**
 * One entry per asset, newest first: its current version, a replacement on its way, and the
 * tours that use it. Versions the database no longer lists (deleted) are simply absent.
 */
export function groupMediaVersions<V extends VersionLike>(
  views: readonly V[],
  uses: readonly MediaUse[],
): MediaAsset<V>[] {
  const byAsset = new Map<string, V[]>();
  for (const view of views) {
    const list = byAsset.get(view.assetId) ?? [];
    list.push(view);
    byAsset.set(view.assetId, list);
  }
  const groups: { readonly newest: number; readonly asset: MediaAsset<V> }[] = [];
  for (const [assetId, versions] of byAsset) {
    const sorted = [...versions].sort((a, b) => b.version - a.version);
    const newest = sorted[0];
    if (!newest) continue;
    const current = sorted.find((view) => view.status === "ready") ?? newest;
    const replacement = newest.version > current.version ? newest : null;
    const assetUses = uses.filter((use) => use.assetId === assetId);
    const tours = toursOf(assetUses, current.status === "ready" ? current.version : null);
    groups.push({
      newest: newest.version,
      asset: {
        assetId,
        current,
        replacement,
        tours,
        outdatedTours: tours.filter((tour) => tour.outdated).length,
        deletable: assetUses.length === 0 && !sorted.some((view) => view.status === "processing"),
      },
    });
  }
  // Keep the order the list came in (newest first) by the position of each asset's first row.
  const order = new Map<string, number>();
  views.forEach((view, index) => {
    if (!order.has(view.assetId)) order.set(view.assetId, index);
  });
  return groups
    .map((group) => group.asset)
    .sort((a, b) => (order.get(a.assetId) ?? 0) - (order.get(b.assetId) ?? 0));
}

function toursOf(uses: readonly MediaUse[], currentVersion: number | null): TourUse[] {
  const byTour = new Map<string, MediaUse[]>();
  for (const use of uses) {
    const list = byTour.get(use.tourId) ?? [];
    list.push(use);
    byTour.set(use.tourId, list);
  }
  return [...byTour.values()]
    .map((rows): TourUse => {
      const first = rows[0] as MediaUse;
      const draft = rows.some((row) => row.scope === "draft");
      const published = rows.some((row) => row.scope === "published");
      return {
        tourId: first.tourId,
        contentId: first.contentId,
        contentKind: first.contentKind,
        contentTitle: first.contentTitle,
        draft,
        published,
        historyOnly: !draft && !published,
        outdated:
          currentVersion !== null &&
          rows.some((row) => row.working && row.version < currentVersion),
      };
    })
    .sort((a, b) => a.contentTitle.localeCompare(b.contentTitle, "es"));
}

/**
 * For the tour editor: the newest ready version of each asset, never one of an asset the
 * tour already uses (an older version of it included).
 */
export function latestReadyVersions<V extends VersionLike>(
  views: readonly V[],
  usedAssets: ReadonlySet<string> = new Set(),
): V[] {
  const latest = new Map<string, V>();
  for (const view of views) {
    if (view.status !== "ready" || usedAssets.has(view.assetId)) continue;
    const known = latest.get(view.assetId);
    if (!known || view.version > known.version) latest.set(view.assetId, view);
  }
  return views.filter((view) => latest.get(view.assetId) === view);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** «Usar la versión nueva en los tours»: it goes to their drafts (ADR-048). */
export async function applyMediaReplacement(
  membership: OrganizationMembership,
  versionId: unknown,
  library: Pick<MediaLibraryRepository, "applyReplacement">,
): Promise<ApplyReplacementOutcome> {
  if (!MEDIA_REPLACERS.includes(membership.role)) return { status: "forbidden" };
  if (typeof versionId !== "string" || !UUID.test(versionId)) return { status: "not_found" };
  return library.applyReplacement(membership.tenantId, versionId);
}

/** «Borrar»: only what no tour ever used; the files go with it (ADR-048). */
export async function deleteTourMedia(
  membership: OrganizationMembership,
  assetId: unknown,
  library: Pick<MediaLibraryRepository, "deleteAsset">,
): Promise<DeleteMediaOutcome> {
  if (!MEDIA_DELETERS.includes(membership.role)) return { status: "forbidden" };
  if (typeof assetId !== "string" || !UUID.test(assetId)) return { status: "not_found" };
  return library.deleteAsset(membership.tenantId, assetId);
}

/** Whether a string is an asset id (the upload actions receive it from the browser). */
export function isAssetId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
