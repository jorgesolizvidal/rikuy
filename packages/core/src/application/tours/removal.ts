import type { OrganizationMembership } from "../../contracts/organization";
import type { TourContentKind } from "../../contracts/tour";
import { canPublishContent } from "../content/editing";
import { tourPath } from "../content/portal";
import type { TourCandidate, TourRepository } from "./tours";

/**
 * Deleting a tour, or moving it to another destination or event (C0 · Paso 3, ADR-049).
 * Owners and admins only, like publishing. Deleting is final: the tour, its versions and its
 * history go, and its media are free to delete (ADR-048). A moved tour keeps everything;
 * its old page leads to it. "Go to another tour" points of other tours keep pointing to
 * their place: without a tour there, visitors do not see them, and the panel says which.
 */

/** A tour with a "go to another tour" point leading to this tour's place. */
export interface TourLinkFrom {
  readonly tourId: string;
  readonly contentKind: TourContentKind;
  readonly contentTitle: string;
  /** In its draft. */
  readonly draft: boolean;
  /** In its published version (visitors see it today). */
  readonly published: boolean;
}

export interface TourRemovalImpact {
  readonly contentId: string;
  /** Published versions (its history). */
  readonly revisions: number;
  readonly published: boolean;
  readonly inGeneralTour: boolean;
  readonly startsGeneralTour: boolean;
  readonly linkedFrom: readonly TourLinkFrom[];
}

export interface TourPlace {
  readonly kind: TourContentKind;
  readonly slug: string;
}

export type DeleteTourOutcome =
  | {
      readonly status: "deleted";
      readonly place: TourPlace;
      /** Places it had left: their old tour pages led to it. */
      readonly formerPlaces: readonly TourPlace[];
    }
  | { readonly status: "forbidden" | "not_found" };

export type MoveTourOutcome =
  | {
      readonly status: "moved";
      readonly from: TourPlace;
      readonly to: TourPlace;
      /** Places it had left before: their old tour pages lead to it. */
      readonly formerPlaces: readonly TourPlace[];
    }
  /** same: already there · taken: that place has a tour · self_link: a point of the tour
   *  (its draft, or its published version without one) leads to that place. */
  | { readonly status: "same" | "taken" | "self_link" | "forbidden" | "not_found" };

/** With the signed-in user's session; the database checks role and tenant again. */
export interface TourRemovalRepository {
  removalImpact(tenantId: string, tourId: string): Promise<TourRemovalImpact | null>;
  deleteTour(tenantId: string, tourId: string): Promise<DeleteTourOutcome>;
  moveTour(tenantId: string, tourId: string, contentId: string): Promise<MoveTourOutcome>;
}

export interface TourRemoval {
  readonly impact: TourRemovalImpact;
  /** Destinations and events without a tour, where this one can go. */
  readonly destinations: readonly TourCandidate[];
  /** Owners and admins delete and move; everyone else only sees nothing to do. */
  readonly canRemove: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** For the tour editor: what deleting or moving it changes, and where it can go. */
export async function loadTourRemoval(
  membership: OrganizationMembership,
  tourId: unknown,
  deps: {
    readonly removal: Pick<TourRemovalRepository, "removalImpact">;
    readonly tours: Pick<TourRepository, "list">;
    readonly candidates: () => Promise<readonly TourCandidate[]>;
  },
): Promise<TourRemoval | null> {
  if (!isId(tourId)) return null;
  const canRemove = canPublishContent(membership.role);
  const [impact, tours, all] = await Promise.all([
    deps.removal.removalImpact(membership.tenantId, tourId),
    canRemove ? deps.tours.list(membership.tenantId) : Promise.resolve([]),
    canRemove ? deps.candidates() : Promise.resolve([]),
  ]);
  if (!impact) return null;
  const taken = new Set(tours.map((tour) => tour.contentId));
  return {
    impact,
    destinations: all.filter((candidate) => !taken.has(candidate.contentId)),
    canRemove,
  };
}

/** «Borrar el tour»: final; returns its place (the panel goes back to the list). */
export async function deleteTour(
  membership: OrganizationMembership,
  tourId: unknown,
  removal: Pick<TourRemovalRepository, "deleteTour">,
): Promise<DeleteTourOutcome> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  if (!isId(tourId)) return { status: "not_found" };
  return removal.deleteTour(membership.tenantId, tourId);
}

/** «Pasar a otro destino o evento». */
export async function moveTour(
  membership: OrganizationMembership,
  input: { readonly tourId: unknown; readonly contentId: unknown },
  removal: Pick<TourRemovalRepository, "moveTour">,
): Promise<MoveTourOutcome> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  if (!isId(input.tourId) || !isId(input.contentId)) return { status: "not_found" };
  return removal.moveTour(membership.tenantId, input.tourId, input.contentId);
}

/** The portal pages a delete or a move changes beyond the municipality's lists: the tour
 *  pages of the places involved (they are no longer in the index). */
export function tourPagesOf(...places: readonly TourPlace[]): string[] {
  return places.map((place) => tourPath(place.kind, place.slug));
}

/** Where an old tour page leads (anonymous, the portal): the moved tour, else its place. */
export interface TourRedirect {
  readonly kind: TourContentKind;
  readonly slug: string;
  readonly target: "tour" | "place";
}

export interface PublishedTourRedirectReader {
  find(tenantId: string, kind: TourContentKind, slug: string): Promise<TourRedirect | null>;
}
