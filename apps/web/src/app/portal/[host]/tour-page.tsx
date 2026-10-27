import "server-only";

import {
  PORTAL_PATHS,
  tourPath,
  tourViewerModel,
  type TourContentKind,
  type TourViewerPoint,
} from "@rikuy/core";
import { publicMediaUrl } from "@rikuy/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { preload } from "react-dom";

import { platformSettings } from "@/server/platform";
import { portalTour, responsiveImage } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { TourExplorer, type TourPointDto, type TourSceneDto } from "./tour-explorer";

/**
 * The tour page of a destination or an event (P4 · Paso 4), cached with the rest of the
 * portal (ADR-024). It reads one sealed manifest; the panoramas are public, versioned files,
 * and only the scene on screen is downloaded. The scene in a shared link (?escena=) is
 * chosen in the browser, so the page stays one cached page per tour.
 */
export interface TourPageParams {
  readonly params: Promise<{ host: string; slug: string }>;
}

async function load(kind: TourContentKind, params: TourPageParams["params"]) {
  const { host, slug } = await params;
  const view = await portalView(host);
  if (view === null) return null;
  const tour = await portalTour(view, kind, decodeURIComponent(slug));
  return tour ? { view, tour } : null;
}

function describe(title: string, scenes: number): string {
  return `Recorre ${title} en 360°: ${scenes === 1 ? "una escena" : `${scenes} escenas`} con información, fotos y modelos 3D.`;
}

export async function tourMetadata(
  kind: TourContentKind,
  params: TourPageParams["params"],
): Promise<Metadata> {
  const loaded = await load(kind, params);
  if (loaded === null) return {};
  const { tour } = loaded;
  const title = `Tour 360° de ${tour.title}`;
  const description = describe(tour.title, tour.manifest.scenes.length);
  return {
    title,
    description,
    alternates: { canonical: tourPath(kind, tour.slug) },
    // Like the event's page: an ended event's tour stays for shared links, out of search.
    ...(tour.ended ? { robots: { index: false, follow: true } } : {}),
    openGraph: { type: "website", title, description },
  };
}

export async function TourPage({
  kind,
  params,
}: {
  readonly kind: TourContentKind;
  readonly params: TourPageParams["params"];
}) {
  const loaded = await load(kind, params);
  if (loaded === null) notFound();
  const { view, tour } = loaded;
  const tenantId = view.context.tenant.tenantId;
  const supabaseUrl = platformSettings().env.NEXT_PUBLIC_SUPABASE_URL;
  const url = (path: string) => publicMediaUrl(supabaseUrl, path);
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
          poster: {
            url: url(point.poster.path),
            width: point.poster.width,
            height: point.poster.height,
          },
        };
      case "tour":
        return { ...base, kind: "tour", href: point.target.href, targetTitle: point.target.title };
    }
  };
  const scenes: TourSceneDto[] = model.scenes.map((scene) => ({
    id: scene.id,
    title: scene.title,
    description: scene.description,
    initialView: scene.initialView,
    previewUrl: url(scene.panorama.preview),
    image: {
      url: url(scene.panorama.image.path),
      width: scene.panorama.image.width,
      height: scene.panorama.image.height,
    },
    tiles: scene.panorama.tiles
      ? { folderUrl: url(scene.panorama.tiles.folder), levels: scene.panorama.tiles.levels }
      : null,
    points: scene.points.map(pointDto),
  }));

  // The entry's preview is the first thing on screen (and the page's largest image).
  const entry = scenes.find((scene) => scene.id === model.entrySceneId);
  if (entry) preload(entry.previewUrl, { as: "image", fetchPriority: "high" });

  const contentPath =
    kind === "destination" ? PORTAL_PATHS.destination(tour.slug) : PORTAL_PATHS.event(tour.slug);
  const section =
    kind === "destination"
      ? { href: PORTAL_PATHS.destinations, label: "Destinos" }
      : { href: PORTAL_PATHS.agenda, label: "Agenda" };

  return (
    <article className="portal-page portal-tour">
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li>
            <a href={section.href}>{section.label}</a>
          </li>
          <li>
            <a href={contentPath}>{tour.title}</a>
          </li>
          <li aria-current="page">Tour 360°</li>
        </ol>
      </nav>
      <header className="portal-tour-header">
        <p className="portal-tour-eyebrow">Tour 360°</p>
        <h1 className="portal-page-title">{tour.title}</h1>
        {tour.ended ? (
          <p className="portal-ended" role="status">
            Este evento ya terminó. El tour sigue disponible.
          </p>
        ) : null}
      </header>
      <TourExplorer
        title={tour.title}
        entrySceneId={model.entrySceneId}
        scenes={scenes}
        backHref={contentPath}
        backLabel={tour.title}
      />
    </article>
  );
}
