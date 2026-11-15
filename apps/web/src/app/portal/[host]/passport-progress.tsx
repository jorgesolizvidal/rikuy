"use client";

import {
  circuitProgress,
  nextSuggestedStop,
  type PassportStamp,
} from "@rikuy/core/passport-client";

import { usePassport } from "@/lib/passport-store";

import { ProgressRing, StampSeal, type SealState } from "./stamp-seal";

/**
 * What this phone has collected (ADR-057), on the passport's pages. The pages are cached for
 * everyone, so this part is filled in the browser; its space is the same before and after, so
 * nothing moves (C3 · Paso 5, ADR-064: the stops as round seals and the progress as a ring).
 */

export function stampDate(at: number): string {
  return new Date(at * 1000).toLocaleDateString("es-BO", { day: "numeric", month: "short" });
}

/** «13 NOV», inside a seal. */
export function sealDate(at: number): string {
  return stampDate(at).replace(".", "").toLocaleUpperCase("es");
}

export function stampWords(stamp: PassportStamp): string {
  return `Sellado el ${stampDate(stamp.at)} · ${stamp.located ? "con ubicación" : "sin ubicación"}`;
}

export interface CircuitStopDto {
  /** The place (content id); null until the stamps migration runs. */
  readonly id: string | null;
  readonly slug: string;
  readonly title: string;
  readonly href: string;
}

function progressWords(collected: number, total: number, complete: boolean): string {
  if (complete) return "¡Completaste el circuito!";
  if (collected === 0) return "Todavía no tienes sellos de este circuito en este teléfono.";
  return `Tienes ${collected} de ${total} sellos en este teléfono.`;
}

/** «Tienes 2 de 4 sellos», under a circuit in the passport's list. */
export function CircuitProgressLine({ stopIds }: { readonly stopIds: readonly (string | null)[] }) {
  const passport = usePassport();
  const progress = circuitProgress(stopIds, passport?.stamps ?? {});
  return (
    <div className="passport-progress-row">
      <ProgressRing collected={progress.collected} total={progress.total} size={56} />
      <p className="passport-progress" data-complete={progress.complete ? "true" : "false"}>
        {passport === undefined
          ? ""
          : progressWords(progress.collected, progress.total, progress.complete)}
      </p>
    </div>
  );
}

/**
 * A circuit's page (C3 · Paso 5): the ring with the progress and the prize, then every stop as
 * a seal in the suggested order. The next suggested stop is marked, never locked: any order
 * counts (ADR-056).
 */
export function CircuitStamps({
  circuit,
  stops,
  reward,
}: {
  readonly circuit: string;
  readonly stops: readonly CircuitStopDto[];
  readonly reward: string;
}) {
  const passport = usePassport();
  const stamps = passport?.stamps ?? {};
  const stopIds = stops.map((stop) => stop.id);
  const progress = circuitProgress(stopIds, stamps);
  const next = passport === undefined ? null : nextSuggestedStop(stopIds, stamps);
  const missing = progress.total - progress.collected;

  return (
    <>
      <section className="passport-panel" aria-labelledby="avance">
        <ProgressRing collected={progress.collected} total={progress.total} size={88} />
        <div className="passport-panel-text">
          <h2 id="avance" className="passport-panel-title">
            Tu avance
          </h2>
          <p className="passport-progress" data-complete={progress.complete ? "true" : "false"}>
            {passport === undefined
              ? ""
              : progressWords(progress.collected, progress.total, progress.complete)}
          </p>
          {reward ? (
            <p className="passport-reward">
              <strong>Premio:</strong> {reward}
              {passport !== undefined && !progress.complete ? (
                <span className="passport-reward-missing">
                  {" "}
                  · Te {missing === 1 ? "falta 1 sello" : `faltan ${missing} sellos`}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      </section>

      <h2 className="passport-stops-title">
        {stops.length} {stops.length === 1 ? "lugar" : "lugares"}, en el orden sugerido
      </h2>
      <p className="passport-stops-note">Puedes sellarlos en el orden que prefieras.</p>
      <ol className="passport-stops">
        {stops.map((stop, index) => {
          const stamp = stop.id ? stamps[stop.id] : undefined;
          const state: SealState = stamp ? "stamped" : next === index ? "next" : "missing";
          return (
            <li key={stop.slug} className="passport-stop" data-state={state}>
              <span className="passport-stop-number">Parada {index + 1}</span>
              {state === "next" ? (
                <span className="passport-stop-next">Siguiente sugerida</span>
              ) : null}
              <StampSeal
                id={`${circuit}-${stop.slug}`}
                title={stop.title}
                state={state}
                date={stamp ? sealDate(stamp.at) : null}
                located={stamp?.located ?? false}
                size={104}
              />
              <a className="passport-stop-title" href={stop.href}>
                {stop.title}
              </a>
              <span className="passport-stop-stamp" data-stamped={stamp ? "true" : "false"}>
                {passport === undefined ? null : stamp ? (
                  <>
                    <span aria-hidden="true">✓ </span>
                    {stampWords(stamp)}
                  </>
                ) : (
                  "Falta el sello"
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** The seals of a circuit in a row, on the passport's list (decorative: the line says it). */
export function CircuitSeals({
  circuit,
  stops,
}: {
  readonly circuit: string;
  readonly stops: readonly CircuitStopDto[];
}) {
  const passport = usePassport();
  const shown = stops.slice(0, 8);
  return (
    <span className="passport-seal-row" aria-hidden="true">
      {shown.map((stop) => {
        const stamp = stop.id ? passport?.stamps[stop.id] : undefined;
        return (
          <StampSeal
            key={stop.slug}
            id={`fila-${circuit}-${stop.slug}`}
            title={stop.title}
            state={stamp ? "stamped" : "missing"}
            size={44}
          />
        );
      })}
      {stops.length > shown.length ? (
        <span className="passport-seal-more">+{stops.length - shown.length}</span>
      ) : null}
    </span>
  );
}

/** «Tienes 3 sellos en este teléfono», on the passport's page. */
export function PassportSummary() {
  const passport = usePassport();
  const count = passport ? Object.keys(passport.stamps).length : 0;
  return (
    <p className="passport-summary">
      {passport === undefined
        ? ""
        : count === 0
          ? "Todavía no tienes sellos. Escanea el código del pasaporte en cada lugar."
          : `Tienes ${count} ${count === 1 ? "sello" : "sellos"} en este teléfono.`}
    </p>
  );
}
