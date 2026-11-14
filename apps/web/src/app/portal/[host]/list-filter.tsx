"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { searchText } from "./list-search";
import { ProximityList, type ProximityEntry } from "./visitor-location";

/**
 * Search and categories of the destinations and the agenda (ADR-062). The page is cached
 * whole; the filtering happens in the browser over what it already has, and the address
 * keeps it (`?categoria=…&q=…`) so a filtered list can be shared. Nothing is sent anywhere.
 */

export interface FilterCategory {
  readonly slug: string;
  readonly name: string;
}

export interface FilterableEntry extends ProximityEntry {
  /** The slug of its category, or null. */
  readonly category: string | null;
  /** Title, summary and place, as the search reads them (see `searchText`). */
  readonly text: string;
}

const CATEGORY_PARAM = "categoria";
const QUERY_PARAM = "q";

export function useListFilter(categories: readonly FilterCategory[]) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  // From the address once the page is in the browser (the cached HTML has every item).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get(CATEGORY_PARAM);
    const known = categories.some((item) => item.slug === fromUrl);
    /* eslint-disable react-hooks/set-state-in-effect -- reading the address happens once, after hydration */
    if (fromUrl !== null && known) setCategory(fromUrl);
    setQuery(params.get(QUERY_PARAM)?.slice(0, 80) ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [categories]);

  const update = useCallback((next: { query: string; category: string | null }) => {
    setQuery(next.query);
    setCategory(next.category);
    const url = new URL(window.location.href);
    if (next.category) url.searchParams.set(CATEGORY_PARAM, next.category);
    else url.searchParams.delete(CATEGORY_PARAM);
    if (next.query.trim()) url.searchParams.set(QUERY_PARAM, next.query.trim());
    else url.searchParams.delete(QUERY_PARAM);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const words = searchText(query).split(/\s+/u).filter(Boolean);
  const matches = (entry: FilterableEntry) =>
    (category === null || entry.category === category) &&
    words.every((word) => entry.text.includes(word));

  return { query, category, update, matches, active: category !== null || words.length > 0 };
}

export function ListFilterBar({
  categories,
  query,
  category,
  onChange,
  searchLabel,
  placeholder,
  shown,
  total,
  noun,
  search = true,
}: {
  readonly categories: readonly FilterCategory[];
  readonly query: string;
  readonly category: string | null;
  readonly onChange: (next: { query: string; category: string | null }) => void;
  readonly searchLabel: string;
  readonly placeholder: string;
  readonly shown: number;
  readonly total: number;
  /** Singular and plural, for the live count («3 de 7 lugares»). */
  readonly noun: readonly [string, string];
  readonly search?: boolean;
}) {
  const id = useId();
  const filtered = shown !== total;
  return (
    <div className="portal-filters">
      {search ? (
        <div className="portal-search">
          <label htmlFor={`${id}-q`} className="visually-hidden">
            {searchLabel}
          </label>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" focusable="false">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            id={`${id}-q`}
            type="search"
            value={query}
            maxLength={80}
            placeholder={placeholder}
            autoComplete="off"
            onChange={(event) => onChange({ query: event.target.value, category })}
          />
        </div>
      ) : null}
      {categories.length > 0 ? (
        <div className="portal-chips" role="group" aria-label="Categorías">
          <button
            type="button"
            className="portal-chip"
            aria-pressed={category === null}
            onClick={() => onChange({ query, category: null })}
          >
            Todos
          </button>
          {categories.map((item) => (
            <button
              key={item.slug}
              type="button"
              className="portal-chip"
              aria-pressed={category === item.slug}
              onClick={() =>
                onChange({ query, category: category === item.slug ? null : item.slug })
              }
            >
              {item.name}
            </button>
          ))}
        </div>
      ) : null}
      <p className="portal-filter-count" role="status">
        {filtered ? `${String(shown)} de ${String(total)} ${total === 1 ? noun[0] : noun[1]}` : ""}
      </p>
    </div>
  );
}

/** The destinations' list with its filters. */
export function FilteredProximityList({
  entries,
  categories,
  className,
}: {
  readonly entries: readonly FilterableEntry[];
  readonly categories: readonly FilterCategory[];
  readonly className: string;
}) {
  // The visitor's distance order still applies (ProximityList), over what is left.
  const filter = useListFilter(categories);
  const visible = entries.filter(filter.matches);
  return (
    <>
      <ListFilterBar
        categories={categories}
        query={filter.query}
        category={filter.category}
        onChange={filter.update}
        searchLabel="Buscar un lugar"
        placeholder="Buscar por nombre o descripción…"
        shown={visible.length}
        total={entries.length}
        noun={["lugar", "lugares"]}
        search={entries.length > 3}
      />
      {visible.length > 0 ? (
        <ProximityList entries={visible} className={className} />
      ) : (
        <NoMatch onClear={() => filter.update({ query: "", category: null })} />
      )}
    </>
  );
}

export function NoMatch({ onClear }: { readonly onClear: () => void }) {
  return (
    <div className="portal-no-match">
      <p>Nada coincide con lo que buscas.</p>
      <button type="button" className="portal-button" onClick={onClear}>
        Quitar los filtros
      </button>
    </div>
  );
}
