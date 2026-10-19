"use client";

import { sortByDistance } from "@rikuy/core/geo";
import { Fragment, useState } from "react";

import { useVisitorLocation } from "@/lib/use-visitor-location";

import type { ProximityEntry } from "./visitor-location";

export interface AgendaMonth {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly ProximityEntry[];
}

/**
 * The agenda by month. Once the visitor's position is known they can also see every
 * upcoming event from the closest to the farthest (computed on the device).
 */
export function AgendaList({ months }: { readonly months: readonly AgendaMonth[] }) {
  const { fix } = useVisitorLocation();
  const [order, setOrder] = useState<"date" | "proximity">("date");
  const byDistance = fix !== null && order === "proximity";

  return (
    <>
      {fix ? (
        <fieldset className="portal-order">
          <legend>Ordenar</legend>
          <label>
            <input
              type="radio"
              name="orden"
              checked={!byDistance}
              onChange={() => setOrder("date")}
            />
            Por fecha
          </label>
          <label>
            <input
              type="radio"
              name="orden"
              checked={byDistance}
              onChange={() => setOrder("proximity")}
            />
            Por cercanía
          </label>
        </fieldset>
      ) : null}
      {byDistance ? (
        <ul className="portal-events" data-order="proximity">
          {sortByDistance(
            months.flatMap((month) => month.entries),
            fix,
            (entry) => entry.point,
          ).map((entry) => (
            <Fragment key={entry.key}>{entry.node}</Fragment>
          ))}
        </ul>
      ) : (
        months.map((month) => (
          <section key={month.key} className="portal-month" aria-labelledby={`mes-${month.key}`}>
            <h2 id={`mes-${month.key}`}>{month.label}</h2>
            <ul className="portal-events">
              {month.entries.map((entry) => (
                <Fragment key={entry.key}>{entry.node}</Fragment>
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
