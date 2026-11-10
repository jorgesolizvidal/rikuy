import type { TourUse } from "@rikuy/core";
import Link from "next/link";

/**
 * Where a panorama or model is used (ADR-048): each tour, whether its draft or its published
 * version uses it, and whether that is still an older version.
 */
export function MediaAssetUses({
  slug,
  tours,
  noun,
}: {
  readonly slug: string;
  readonly tours: readonly TourUse[];
  /** «este panorama», «este modelo». */
  readonly noun: string;
}) {
  if (tours.length === 0) {
    return <p className="field-hint">Ningún tour usa {noun}.</p>;
  }
  return (
    <div className="media-uses">
      <p className="field-hint">Lo usan:</p>
      <ul>
        {tours.map((tour) => (
          <li key={tour.tourId}>
            <Link href={`/o/${slug}/tours/${tour.tourId}`}>Tour de «{tour.contentTitle}»</Link>{" "}
            <span className="cell-detail">· {where(tour)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function where(tour: TourUse): string {
  if (tour.historyOnly) return "solo en una versión anterior del tour";
  const parts = [tour.published ? "publicado" : null, tour.draft ? "en el borrador" : null].filter(
    (part): part is string => part !== null,
  );
  const scope = parts.join(" y ");
  return tour.outdated ? `${scope}, con la versión anterior` : scope;
}
