"use client";

import { describeProximity, distanceMeters, sortByDistance } from "@rikuy/core/geo";
import { useEffect, useRef, type RefObject } from "react";

import { useVisitorLocation } from "@/lib/use-visitor-location";

import { tourKey, type TourMenuEntryDto } from "./tour-dto";
import { LocationButton } from "./visitor-location";

/**
 * The general tour's menu (P4 · Paso 5): the municipality's tours, in its order or, once
 * the visitor shares the location, the closest first («Cerca de ti», on the device only,
 * ADR-021). It opens over the viewer (also in fullscreen) and each entry jumps to that tour
 * without leaving it. Closed, it is `hidden`: out of sight and out of the accessibility tree.
 * Every entry is a real link, so it also works as a plain page.
 */
const KIND_LABEL = { destination: "Destino", event: "Evento" } as const;

export function TourMenu({
  id,
  entries,
  current,
  loading,
  open,
  onClose,
  onChoose,
  toggle,
}: {
  readonly id: string;
  readonly entries: readonly TourMenuEntryDto[];
  /** The tour on screen. */
  readonly current: string;
  /** The tour being fetched, if any. */
  readonly loading: string | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onChoose: (entry: TourMenuEntryDto) => void;
  /** The button that opens it: the focus goes back there on close. */
  readonly toggle: RefObject<HTMLButtonElement | null>;
}) {
  const { fix } = useVisitorLocation();
  const panel = useRef<HTMLDivElement>(null);
  const ordered = fix ? sortByDistance(entries, fix, (entry) => entry.location) : entries;

  // Opening moves the focus into the menu; Escape closes it and gives it back.
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[aria-current='page'], a, button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      toggle.current?.focus();
    };
    const element = panel.current;
    element?.addEventListener("keydown", onKey);
    return () => element?.removeEventListener("keydown", onKey);
  }, [open, onClose, toggle]);

  return (
    <div
      ref={panel}
      id={id}
      className="tour-menu"
      hidden={!open}
      role="region"
      aria-labelledby={`${id}-title`}
    >
      <div className="tour-menu-header">
        <h2 id={`${id}-title`}>Tours del municipio</h2>
        <button
          type="button"
          className="tour-menu-close"
          onClick={() => {
            onClose();
            toggle.current?.focus();
          }}
        >
          <span aria-hidden="true">×</span>
          <span className="visually-hidden">Cerrar la lista de tours</span>
        </button>
      </div>
      <div className="tour-menu-near">
        <LocationButton label="Ver los más cercanos" />
        {fix ? <p className="tour-menu-note">Cerca de ti primero.</p> : null}
      </div>
      <ol className="tour-menu-list" data-order={fix ? "proximity" : "municipality"}>
        {ordered.map((entry) => {
          const key = tourKey(entry);
          const distance =
            fix && entry.location
              ? describeProximity(distanceMeters(fix, entry.location)).distance
              : null;
          return (
            <li key={key}>
              <a
                href={entry.href}
                className="tour-menu-entry"
                aria-current={key === current ? "page" : undefined}
                aria-busy={key === loading ? true : undefined}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                    return;
                  event.preventDefault();
                  onChoose(entry);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- published, versioned preview */}
                <img
                  src={entry.preview.url}
                  width={entry.preview.width}
                  height={entry.preview.height}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
                <span className="tour-menu-text">
                  <strong>{entry.title}</strong>
                  <span>
                    {KIND_LABEL[entry.kind]} ·{" "}
                    {entry.scenes === 1 ? "1 escena" : `${entry.scenes} escenas`}
                    {distance ? ` · ${distance.replace(/^A /u, "a ")}` : ""}
                  </span>
                  {key === loading ? <span className="tour-menu-loading">Abriendo…</span> : null}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
