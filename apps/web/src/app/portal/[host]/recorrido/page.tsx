import { PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalTour, portalTourIndex } from "@/server/portal-content";
import { tourData } from "@/server/portal-tours";
import { portalView } from "@/server/portal-view";

import { TourArticle } from "../tour-page";

/**
 * The general tour (P4 · Paso 5, ADR-032): every visible tour of the municipality in one
 * viewer, starting with the one it chose, with the menu to jump between them. Cached with
 * the portal; saving the order or publishing a tour refreshes it.
 */
interface GeneralTourPageProps {
  readonly params: Promise<{ host: string }>;
}

async function load(params: GeneralTourPageProps["params"]) {
  const view = await portalView((await params).host);
  if (view === null) return null;
  const index = await portalTourIndex(view);
  const start = index.find((entry) => entry.start) ?? index[0];
  if (!start) return null;
  const tour = await portalTour(view, start.kind, start.slug);
  return tour ? { view, tour, count: index.length } : null;
}

export async function generateMetadata({ params }: GeneralTourPageProps): Promise<Metadata> {
  const loaded = await load(params);
  if (loaded === null) return {};
  const { siteName } = loaded.view.resolved.presentation.identity;
  const { count } = loaded;
  const description = `Recorre en 360° ${count === 1 ? "un lugar" : `${count} lugares`} de ${siteName}, sin salir del visor.`;
  return {
    title: "Tours 360°",
    description,
    alternates: { canonical: PORTAL_PATHS.generalTour },
    openGraph: { type: "website", title: `Tours 360° · ${siteName}`, description },
  };
}

export default async function GeneralTourPage({ params }: GeneralTourPageProps) {
  const loaded = await load(params);
  if (loaded === null) notFound();
  return <TourArticle view={loaded.view} tour={tourData(loaded.view, loaded.tour)} />;
}
