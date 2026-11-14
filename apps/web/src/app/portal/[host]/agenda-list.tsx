"use client";

import { sortByDistance } from "@rikuy/core/geo";
import { Fragment, useState } from "react";

import { useVisitorLocation } from "@/lib/use-visitor-location";

import {
  ListFilterBar,
  NoMatch,
  useListFilter,
  type FilterCategory,
  type FilterableEntry,
} from "./list-filter";

export interface AgendaMonth {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly FilterableEntry[];
}

/**
 * The agenda by month, with the municipality's categories and a search (ADR-062). Once the
 * visitor's position is known they can also see every upcoming event from the closest to the
 * farthest (computed on the device).
 */
export function AgendaList({
  months,
  categories = [],
}: {
  readonly months: readonly AgendaMonth[];
  readonly categories?: readonly FilterCategory[];
}) {
  const { fix } = useVisitorLocation();
  const [order, setOrder] = useState<"date" | "proximity">("date");
  const byDistance = fix !== null && order === "proximity";
  const filter = useListFilter(categories);
  const total = months.reduce((sum, month) => sum + month.entries.length, 0);
  const visible = months
    .map((month) => ({ ...month, entries: month.entries.filter(filter.matches) }))
    .filter((month) => month.entries.length > 0);
  const shown = visible.reduce((sum, month) => sum + month.entries.length, 0);

  return (
    <>
      <ListFilterBar
        categories={categories}
        query={filter.query}
        category={filter.category}
        onChange={filter.update}
        searchLabel="Buscar un evento"
        placeholder="Buscar por nombre o lugar…"
        shown={shown}
        total={total}
        noun={["evento", "eventos"]}
        search={total > 3}
      />
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
      {shown === 0 ? (
        <NoMatch onClear={() => filter.update({ query: "", category: null })} />
      ) : byDistance ? (
        <ul className="portal-events" data-layout="photo" data-order="proximity">
          {sortByDistance(
            visible.flatMap((month) => month.entries),
            fix,
            (entry) => entry.point,
          ).map((entry) => (
            <Fragment key={entry.key}>{entry.node}</Fragment>
          ))}
        </ul>
      ) : (
        visible.map((month) => (
          <section key={month.key} className="portal-month" aria-labelledby={`mes-${month.key}`}>
            <h2 id={`mes-${month.key}`}>{month.label}</h2>
            <ul className="portal-events" data-layout="photo">
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
