import type { Metadata } from "next";

import { TourPage, tourMetadata, type TourPageParams } from "../../../tour-page";

export function generateMetadata({ params }: TourPageParams): Promise<Metadata> {
  return tourMetadata("event", params);
}

/** Rendered on the first visit and cached with the portal (ADR-024). */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

export default function EventTourPage({ params }: TourPageParams) {
  return <TourPage kind="event" params={params} />;
}
