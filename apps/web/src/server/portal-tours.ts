import "server-only";

import {
  PORTAL_PATHS,
  tourPath,
  tourViewerModel,
  type PublishedTour,
  type PublishedTourIndexEntry,
  type TourViewerPoint,
} from "@rikuy/core";
import { publicMediaUrl } from "@rikuy/db";

import type {
  TourDataDto,
  TourMenuEntryDto,
  TourPointDto,
} from "@/app/portal/[host]/tour-explorer";

import { platformSettings } from "./platform";
import { responsiveImage } from "./portal-content";
import type { PortalView } from "./portal-view";

/**
 * What the portal's tour explorer receives: one tour as the browser needs it (public URLs,
 * only the points a visitor can use) and the general tour's menu. The same data serves the
 * tour pages and the JSON the explorer asks for when it jumps to another tour.
 */
function mediaUrl(path: string): string {
  return publicMediaUrl(platformSettings().env.NEXT_PUBLIC_SUPABASE_URL, path);
}

const MEGABYTES = new Intl.NumberFormat("es", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

/** "1,9 MB": what a visitor reads next to "Ver en 3D". */
function megabytes(bytes: number): string {
  return `${MEGABYTES.format(Math.max(0.1, bytes / (1024 * 1024)))} MB`;
}

export function tourData(view: PortalView, tour: PublishedTour): TourDataDto {
  const tenantId = view.context.tenant.tenantId;
  const model = tourViewerModel(tour);

  const pointDto = (point: TourViewerPoint): TourPointDto => {
    const base = { id: point.id, title: point.title, yaw: point.yaw, pitch: point.pitch };
    switch (point.kind) {
      case "info":
        return {
          ...base,
          kind: "info",
          body: point.body,
          gallery: point.gallery.map((image) => responsiveImage(tenantId, image)),
        };
      case "scene":
        return {
          ...base,
          kind: "scene",
          targetSceneId: point.targetSceneId,
          targetTitle: point.targetTitle,
        };
      case "model":
        return {
          ...base,
          kind: "model",
          body: point.body,
          poster: {
            url: mediaUrl(point.poster.path),
            width: point.poster.width,
            height: point.poster.height,
          },
          model: {
            url: mediaUrl(point.model.path),
            size: megabytes(point.model.bytes),
            heavy: point.model.heavy,
          },
        };
      case "tour":
        return {
          ...base,
          kind: "tour",
          href: point.target.href,
          targetKind: point.target.kind,
          targetSlug: point.target.slug,
          targetTitle: point.target.title,
        };
    }
  };

  const destination = tour.kind === "destination";
  return {
    kind: tour.kind,
    slug: tour.slug,
    title: tour.title,
    href: tourPath(tour.kind, tour.slug),
    ended: tour.ended,
    contentHref: destination ? PORTAL_PATHS.destination(tour.slug) : PORTAL_PATHS.event(tour.slug),
    section: destination
      ? { href: PORTAL_PATHS.destinations, label: "Destinos" }
      : { href: PORTAL_PATHS.agenda, label: "Agenda" },
    entrySceneId: model.entrySceneId,
    scenes: model.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      description: scene.description,
      initialView: scene.initialView,
      previewUrl: mediaUrl(scene.panorama.preview),
      image: {
        url: mediaUrl(scene.panorama.image.path),
        width: scene.panorama.image.width,
        height: scene.panorama.image.height,
      },
      tiles: scene.panorama.tiles
        ? { folderUrl: mediaUrl(scene.panorama.tiles.folder), levels: scene.panorama.tiles.levels }
        : null,
      points: scene.points.map(pointDto),
    })),
  };
}

/** The general tour's menu: every visible tour, in the municipality's order. */
export function tourMenu(index: readonly PublishedTourIndexEntry[]): TourMenuEntryDto[] {
  return index.map((entry) => ({
    kind: entry.kind,
    slug: entry.slug,
    title: entry.title,
    href: tourPath(entry.kind, entry.slug),
    scenes: entry.scenes,
    preview: {
      url: mediaUrl(entry.entryFolder + entry.entryPreview.file),
      width: entry.entryPreview.width,
      height: entry.entryPreview.height,
    },
    location: entry.location,
    start: entry.start,
  }));
}
