"use client";

import {
  describeProximity,
  distanceMeters,
  sortByDistance,
  updateNearby,
  type GeoPoint,
} from "@rikuy/core";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { useVisitorLocation } from "@/lib/use-visitor-location";
import { locationMessage } from "@/lib/visitor-location";

/**
 * Visitor location on portal pages (ADR-021). Everything here runs on the device: the
 * position is never sent anywhere. Without it (not asked, refused, unknown) every page
 * shows the same content, in the municipality's order.
 */

/** «Usar mi ubicación» / «Dejar de usar mi ubicación», with the state in words. */
export function LocationButton({ label = "Usar mi ubicación" }: { readonly label?: string }) {
  const { status, start, stop } = useVisitorLocation();
  const active = status === "on" || status === "starting" || status === "paused";
  const message = locationMessage(status);
  if (status === "unsupported") return null;
  return (
    <div className="portal-location-control">
      <button
        type="button"
        className="portal-button portal-location-button"
        data-active={active}
        onClick={active ? stop : start}
        disabled={status === "insecure"}
      >
        <span className="portal-location-icon" aria-hidden="true" />
        {active ? "Dejar de usar mi ubicación" : status === "denied" ? "Intentar de nuevo" : label}
      </button>
      <p className="portal-location-status" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}

/** "A 350 m en línea recta · ~5 min a pie · ~1 min en auto (estimado)", once known. */
export function DistanceText({
  point,
  compact = false,
}: {
  readonly point: GeoPoint;
  readonly compact?: boolean;
}) {
  const { fix } = useVisitorLocation();
  if (!fix) return null;
  const text = describeProximity(distanceMeters(fix, point));
  return (
    <span className="portal-distance" data-compact={compact}>
      <span className="portal-distance-line">{text.distance}</span>
      {text.travel && !compact ? (
        <span className="portal-distance-travel">{text.travel}</span>
      ) : null}
    </span>
  );
}

export interface ProximityEntry {
  readonly key: string;
  readonly point: GeoPoint | null;
  readonly node: ReactNode;
}

/**
 * A list in the municipality's order that, once the visitor's position is known, shows
 * the closest first. The items are the same server-rendered cards in both orders.
 */
export function ProximityList({
  entries,
  className,
}: {
  readonly entries: readonly ProximityEntry[];
  readonly className: string;
}) {
  const { fix } = useVisitorLocation();
  const ordered = fix ? sortByDistance(entries, fix, (entry) => entry.point) : entries;
  return (
    <ul className={className} data-order={fix ? "proximity" : "original"}>
      {ordered.map((entry) => (
        <Fragment key={entry.key}>{entry.node}</Fragment>
      ))}
    </ul>
  );
}

/** Says, when the position is known, that the list is sorted by distance. */
export function ProximityNote({ children }: { readonly children?: ReactNode }) {
  const { fix } = useVisitorLocation();
  if (!fix) return children ?? null;
  return <p className="portal-proximity-note">Ordenados por cercanía a tu ubicación.</p>;
}

export interface NearbyTargetDto {
  readonly key: string;
  readonly title: string;
  readonly href: string;
  readonly lat: number;
  readonly lng: number;
}

/** "a 80 m en línea recta" */
function nearbyDistance(meters: number): string {
  return describeProximity(meters).distance.replace(/^A /u, "a ");
}

/**
 * «Estás cerca de…»: a notice when the visitor walks into a destination's radius, only
 * while the page is open (no background alerts). Each place is announced once until the
 * visitor leaves it; closing the notice does not turn the location off.
 */
export function NearbyNotice({
  targets,
  radius,
}: {
  readonly targets: readonly NearbyTargetDto[];
  readonly radius: number;
}) {
  const { fix } = useVisitorLocation();
  const inside = useRef<ReadonlySet<string>>(new Set());
  const [announced, setAnnounced] = useState<NearbyTargetDto | null>(null);

  useEffect(() => {
    if (!fix) {
      inside.current = new Set();
      return;
    }
    const update = updateNearby(
      inside.current,
      fix,
      targets.map((target) => ({ key: target.key, point: target })),
      radius,
    );
    inside.current = update.inside;
    const first = update.entered[0];
    if (first) {
      const target = targets.find((candidate) => candidate.key === first) ?? null;
      // A reading from the device, outside React: announcing it is the effect's job.
      setAnnounced(target);
    }
  }, [fix, targets, radius]);

  const current = announced && fix ? { target: announced, fix } : null;
  return (
    <div className="portal-nearby" role="status" aria-live="polite">
      {current ? (
        <div className="portal-nearby-card">
          <p>
            <span className="portal-nearby-label">Estás cerca de</span>{" "}
            <a href={current.target.href}>{current.target.title}</a>
            <span className="portal-nearby-distance">
              {" "}
              · {nearbyDistance(distanceMeters(current.fix, current.target))}
            </span>
          </p>
          <button
            type="button"
            className="portal-nearby-close"
            aria-label="Cerrar aviso"
            onClick={() => setAnnounced(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
