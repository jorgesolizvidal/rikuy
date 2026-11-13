"use client";

import { circuitProgress, type PassportStamp } from "@rikuy/core/passport-client";

import { usePassport } from "@/lib/passport-store";

/**
 * What this phone has collected (ADR-057), on the passport's pages. The pages are cached for
 * everyone, so this part is filled in the browser; its space is reserved so nothing moves.
 */

export function stampDate(at: number): string {
  return new Date(at * 1000).toLocaleDateString("es-BO", { day: "numeric", month: "short" });
}

export function stampWords(stamp: PassportStamp): string {
  return `Sellado el ${stampDate(stamp.at)} · ${stamp.located ? "con ubicación" : "sin ubicación"}`;
}

/** «Tienes 2 de 4 sellos», under a circuit. */
export function CircuitProgressLine({ stopIds }: { readonly stopIds: readonly (string | null)[] }) {
  const passport = usePassport();
  let text = "";
  if (passport !== undefined) {
    const progress = circuitProgress(stopIds, passport?.stamps ?? {});
    text = progress.complete
      ? "¡Completaste el circuito! Muy pronto podrás pedir aquí tu premio."
      : progress.collected === 0
        ? "Todavía no tienes sellos de este circuito en este teléfono."
        : `Tienes ${progress.collected} de ${progress.total} sellos en este teléfono.`;
  }
  const complete =
    passport != null && circuitProgress(stopIds, passport.stamps).complete ? "true" : "false";
  return (
    <p className="passport-progress" data-complete={complete}>
      {text}
    </p>
  );
}

/** «Sellado el 13 nov · con ubicación», in a stop's card. */
export function StopStamp({ placeId }: { readonly placeId: string | null }) {
  const passport = usePassport();
  const stamp = placeId ? passport?.stamps[placeId] : undefined;
  return (
    <span className="passport-stop-stamp" data-stamped={stamp ? "true" : "false"}>
      {stamp ? (
        <>
          <span aria-hidden="true">✓ </span>
          {stampWords(stamp)}
        </>
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
