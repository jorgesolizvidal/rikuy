import "server-only";
import "./tour.css";

import { PORTAL_PATHS, tourPath, type TourContentKind } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { preload } from "react-dom";

import { portalTour, portalTourIndex } from "@/server/portal-content";
import { tourData, tourMenu } from "@/server/portal-tours";
import type { PortalView } from "@/server/portal-view";
import { portalView } from "@/server/portal-view";

import { TourExplorer, type TourDataDto } from "./tour-explorer";

/**
 * The tour pages (P4 · Paso 4 and 5): one per destination or event with a tour, and the
 * general tour (`/recorrido`), which opens on the tour the municipality chose. Cached with
 * the rest of the portal (ADR-024); each reads one sealed manifest and the general tour's
 * index. The scene in a shared link (?escena=) is chosen in the browser, so each stays one
 * cached page.
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

/** The explorer with one tour and the general tour's menu. */
export async function TourArticle({
  view,
  tour,
}: {
  readonly view: PortalView;
  readonly tour: TourDataDto;
}) {
  // The entry's preview is the first thing on screen (and the page's largest image).
  const entry = tour.scenes.find((scene) => scene.id === tour.entrySceneId);
  if (entry) preload(entry.previewUrl, { as: "image", fetchPriority: "high" });
  return (
    <article className="portal-page portal-tour">
      <TourExplorer
        tour={tour}
        menu={tourMenu(await portalTourIndex(view))}
        dataPath={PORTAL_PATHS.tourData}
        siteName={view.resolved.presentation.identity.siteName}
      />
    </article>
  );
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
  return <TourArticle view={loaded.view} tour={tourData(loaded.view, loaded.tour)} />;
}
