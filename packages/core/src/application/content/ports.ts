import type { DestinationDocument, GeoPoint } from "../../contracts/destination";
import type { EventDocument, EventSchedule } from "../../contracts/event";
import type { BoundingBox } from "../../domain/geo/bounds";
import type { RichText } from "../../contracts/rich-text";

/** Where a destination stands for its editors. */
export type ContentStatus = "draft" | "published" | "changed";

export interface DestinationListEntry {
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  /** draft: never published · published: no open draft · changed: published + open draft */
  readonly status: ContentStatus;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

export interface ContentRevisionEntry {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly title: string;
  readonly sealedAt: string;
}

export interface OpenDraft<D = DestinationDocument> {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly editCount: number;
  readonly updatedAt: string;
  readonly document: D;
}

export interface PublishedRevision<D = DestinationDocument> {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly document: D;
}

export interface ContentRecord<D> {
  readonly contentId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly draft: OpenDraft<D> | null;
  readonly published: PublishedRevision<D> | null;
  /** Sealed revisions, newest first. */
  readonly history: readonly ContentRevisionEntry[];
}

export type DestinationRecord = ContentRecord<DestinationDocument>;
export type EventRecord = ContentRecord<EventDocument>;

/** An event in the panel's agenda (schedule of the draft, else of the published one). */
export interface EventListEntry {
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  readonly status: ContentStatus;
  readonly schedule: EventSchedule | null;
  /** Already over in the municipality's time zone. */
  readonly ended: boolean;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

export type CreateContentOutcome =
  | { readonly status: "created"; readonly contentId: string }
  | { readonly status: "slug_taken" | "invalid" | "forbidden" };

export type SaveContentOutcome =
  | { readonly status: "saved"; readonly revisionNo: number; readonly editCount: number }
  | { readonly status: "invalid"; readonly reason: "shape" | "media" | "venue" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type PublishContentOutcome =
  | { readonly status: "published"; readonly revisionNo: number }
  | { readonly status: "invalid"; readonly reason: "incomplete" | "media" }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type RestoreContentOutcome =
  | { readonly status: "restored"; readonly revisionNo: number }
  | { readonly status: "conflict" | "forbidden" | "not_found" };

export type DiscardDraftOutcome =
  | { readonly status: "discarded" }
  | { readonly status: "never_published" | "conflict" | "forbidden" | "not_found" };

/** Editorial content with the signed-in user's session (RLS and RPC checks apply). */
export interface ContentRepository {
  listDestinations(tenantId: string): Promise<DestinationListEntry[]>;
  createDestination(tenantId: string, slug: string, title: string): Promise<CreateContentOutcome>;
  findDestination(tenantId: string, contentId: string): Promise<DestinationRecord | null>;
  /** Any revision of the item (to preview history). */
  revisionDocument(tenantId: string, revisionId: string): Promise<DestinationDocument | null>;
  listEvents(tenantId: string): Promise<EventListEntry[]>;
  createEvent(tenantId: string, slug: string, title: string): Promise<CreateContentOutcome>;
  findEvent(tenantId: string, contentId: string): Promise<EventRecord | null>;
  /** Saves the whole draft; the database validates it for the item's kind. */
  saveDraft(
    tenantId: string,
    contentId: string,
    document: DestinationDocument | EventDocument,
    expectedEdit: number | null,
  ): Promise<SaveContentOutcome>;
  publish(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<PublishContentOutcome>;
  restore(tenantId: string, contentId: string, revisionId: string): Promise<RestoreContentOutcome>;
  discardDraft(
    tenantId: string,
    contentId: string,
    expectedEdit: number,
  ): Promise<DiscardDraftOutcome>;
  /** Canonical portal hostname of the tenant (public information), or null. */
  portalHostname(tenantId: string): Promise<string | null>;
}

/** A published image with the pixel size of its original (to reserve layout space). */
export interface PublishedImage {
  readonly assetId: string;
  readonly version: number;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

export interface PublishedDestinationSummary {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly cover: PublishedImage | null;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

export interface PublishedDestination extends PublishedDestinationSummary {
  readonly revisionNo: number;
  readonly body: RichText;
  readonly gallery: readonly PublishedImage[];
}

/** Anonymous reads for portals: only published revisions of active tenants. */
export interface PublishedDestinationReader {
  list(tenantId: string): Promise<PublishedDestinationSummary[]>;
  find(tenantId: string, slug: string): Promise<PublishedDestination | null>;
}

export interface PublishedEventSummary {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly schedule: EventSchedule;
  /** Instants (ISO 8601) computed with the municipality's time zone. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: GeoPoint | null;
  readonly cover: PublishedImage | null;
  /** The published destination where it happens, if any. */
  readonly venue: { readonly slug: string; readonly title: string } | null;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

export interface PublishedEvent extends PublishedEventSummary {
  readonly revisionNo: number;
  readonly body: RichText;
  readonly gallery: readonly PublishedImage[];
  /** The page stays reachable after the event; it says it is over. */
  readonly ended: boolean;
}

/** Anonymous reads for portals: upcoming events (list) and any published one (find). */
export interface PublishedEventReader {
  list(tenantId: string): Promise<PublishedEventSummary[]>;
  find(tenantId: string, slug: string): Promise<PublishedEvent | null>;
}

export type MapPlaceKind = "destination" | "event";

/** One marker of the portal map (and its row in the equivalent list). */
export interface PortalMapPlace {
  readonly kind: MapPlaceKind;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly location: GeoPoint;
  /** Events only. */
  readonly schedule: EventSchedule | null;
  readonly cover: PublishedImage | null;
}

export interface PortalMapExtent {
  /** null when the portal has nothing to show on a map yet. */
  readonly bounds: BoundingBox | null;
  readonly destinations: number;
  readonly events: number;
}

/** Anonymous map reads: places by area (never the whole catalogue) and the overall extent. */
export interface PublishedMapReader {
  extent(tenantId: string): Promise<PortalMapExtent>;
  places(
    tenantId: string,
    area: BoundingBox,
    kinds: readonly MapPlaceKind[],
  ): Promise<PortalMapPlace[]>;
}
