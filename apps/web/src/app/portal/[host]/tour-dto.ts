import type { RichText } from "@rikuy/core";

import type { TourCanvasScene } from "@/components/panorama-viewer/tour-viewer";
import type { ResponsiveImage } from "@/server/portal-content";

/**
 * What the tour explorer receives from the server (P4 · Paso 4 and 5): one tour with public
 * URLs and only the points a visitor can use, and the general tour's menu. Plain data: the
 * page passes it as props and the tour data route returns it as JSON.
 */
interface PointBase {
  readonly id: string;
  readonly title: string;
  readonly yaw: number;
  readonly pitch: number;
}

export type TourKind = "destination" | "event";

export type TourPointDto =
  | (PointBase & {
      readonly kind: "info";
      readonly body: RichText;
      readonly gallery: readonly ResponsiveImage[];
    })
  | (PointBase & {
      readonly kind: "scene";
      readonly targetSceneId: string;
      readonly targetTitle: string;
    })
  | (PointBase & {
      readonly kind: "model";
      readonly poster: { readonly url: string; readonly width: number; readonly height: number };
    })
  | (PointBase & {
      readonly kind: "tour";
      readonly href: string;
      readonly targetKind: TourKind;
      readonly targetSlug: string;
      readonly targetTitle: string;
    });

export interface TourSceneDto {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly initialView: { readonly yaw: number; readonly pitch: number; readonly fov: number };
  readonly previewUrl: string;
  readonly image: { readonly url: string; readonly width: number; readonly height: number };
  readonly tiles: TourCanvasScene["tiles"];
  readonly points: readonly TourPointDto[];
}

export interface TourDataDto {
  readonly kind: TourKind;
  readonly slug: string;
  readonly title: string;
  /** The tour's own page. */
  readonly href: string;
  /** Events: already over. */
  readonly ended: boolean;
  /** The destination's or event's page, and its section (breadcrumb, "back"). */
  readonly contentHref: string;
  readonly section: { readonly href: string; readonly label: string };
  readonly entrySceneId: string;
  readonly scenes: readonly TourSceneDto[];
}

export interface TourMenuEntryDto {
  readonly kind: TourKind;
  readonly slug: string;
  readonly title: string;
  readonly href: string;
  readonly scenes: number;
  /** The entry scene's blurred preview (≤ 40 KB), loaded only when the menu opens. */
  readonly preview: { readonly url: string; readonly width: number; readonly height: number };
  readonly location: { readonly lat: number; readonly lng: number } | null;
  /** The tour the general tour starts with. */
  readonly start: boolean;
}

export function tourKey(tour: { readonly kind: TourKind; readonly slug: string }): string {
  return `${tour.kind}:${tour.slug}`;
}
