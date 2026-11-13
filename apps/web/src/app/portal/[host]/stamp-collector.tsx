"use client";

import { describeProximity } from "@rikuy/core/geo";
import {
  circuitProgress,
  stampLocation,
  type AddStampOutcome,
  type PassportStamp,
} from "@rikuy/core/passport-client";
import { useRef, useState } from "react";

import { ensurePassportId, keepStamp, usePassport } from "@/lib/passport-store";

import { stampWords } from "./passport-progress";

export interface StampCircuitDto {
  readonly slug: string;
  readonly href: string;
  readonly name: string;
  readonly reward: string;
  readonly stopIds: readonly (string | null)[];
}

/** Why a stamp came out «sin ubicación», in words. */
type LocationNote =
  | { readonly kind: "near" }
  | { readonly kind: "chosen" }
  | { readonly kind: "far"; readonly meters: number }
  | { readonly kind: "imprecise" }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

type State =
  | { readonly step: "ready" }
  | { readonly step: "locating" }
  | { readonly step: "sending" }
  | {
      readonly step: "done";
      readonly outcome: AddStampOutcome;
      readonly note: LocationNote;
    }
  | { readonly step: "error"; readonly message: string };

const POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 30_000,
  timeout: 15_000,
};

function noteText(note: LocationNote): string {
  switch (note.kind) {
    case "near":
      return "Con ubicación: tu teléfono confirmó que estás en el lugar.";
    case "chosen":
      return "Sin ubicación: elegiste no compartirla. El sello vale igual.";
    case "far":
      return `Sin ubicación: tu teléfono dice que estás ${describeProximity(note.meters)
        .distance.replace(/^A /u, "a ")
        .replace(/ en línea recta$/u, "")} de este lugar. El sello vale igual.`;
    case "imprecise":
      return "Sin ubicación: tu ubicación no era lo bastante precisa. El sello vale igual.";
    case "denied":
      return "Sin ubicación: no diste permiso para usar tu ubicación. El sello vale igual.";
    case "unavailable":
      return "Sin ubicación: tu teléfono no pudo saber dónde estás. El sello vale igual.";
  }
}

/** Ends with a period unless it already ends a sentence. */
function sentence(text: string): string {
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, POSITION_OPTIONS),
  );
}

/**
 * Stamping a place (ADR-057). The location is asked only when the visitor presses «Sellar
 * con mi ubicación», and only «near: yes or no» leaves the phone, never the position. The
 * stamp is kept in this phone; one stamp per place counts for every circuit.
 */
export function StampCollector({
  code,
  placeId,
  title,
  location,
  radius,
  circuits,
  passportHref,
}: {
  readonly code: string;
  readonly placeId: string;
  readonly title: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly radius: number;
  readonly circuits: readonly StampCircuitDto[];
  readonly passportHref: string;
}) {
  const passport = usePassport();
  const [state, setState] = useState<State>({ step: "ready" });
  const status = useRef<HTMLParagraphElement>(null);
  const existing: PassportStamp | undefined = passport?.stamps[placeId];
  // Read only after hydration (`passport` is undefined on the server).
  const canLocate =
    passport !== undefined &&
    location !== null &&
    window.isSecureContext &&
    "geolocation" in navigator;
  const busy = state.step === "locating" || state.step === "sending";

  async function stamp(withLocation: boolean) {
    const passportId = ensurePassportId();
    if (passportId === null) {
      setState({
        step: "error",
        message:
          "Tu navegador no deja guardar sellos en este teléfono (por ejemplo, en una ventana privada). Abre esta página en una ventana normal.",
      });
      return;
    }
    let note: LocationNote = { kind: "chosen" };
    if (withLocation && location !== null) {
      setState({ step: "locating" });
      try {
        const position = await currentPosition();
        const result = stampLocation(
          {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          },
          location,
          radius,
        );
        note =
          result.result === "near"
            ? { kind: "near" }
            : result.result === "far"
              ? { kind: "far", meters: result.meters }
              : { kind: "imprecise" };
      } catch (error) {
        note =
          (error as GeolocationPositionError).code === 1
            ? { kind: "denied" }
            : { kind: "unavailable" };
      }
    }
    setState({ step: "sending" });
    let response: Response;
    try {
      response = await fetch("/sellar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, passport: passportId, located: note.kind === "near" }),
      });
    } catch {
      setState({
        step: "error",
        message: "No pudimos sellar: revisa tu conexión e intenta de nuevo.",
      });
      return;
    }
    const body = (await response.json().catch(() => null)) as {
      status?: string;
      stamp?: PassportStamp;
    } | null;
    if (response.status === 404) {
      setState({
        step: "error",
        message:
          "Este código ya no sella: puede que el municipio lo haya renovado. Busca el código del pasaporte en el lugar.",
      });
      return;
    }
    if (!response.ok || body?.status !== "stamped" || !body.stamp) {
      setState({ step: "error", message: "No pudimos sellar. Intenta de nuevo en un momento." });
      return;
    }
    const outcome = keepStamp(passportId, body.stamp);
    if (outcome === null) {
      setState({
        step: "error",
        message:
          "No pudimos guardar el sello en este teléfono. Revisa que el navegador permita guardar datos de este sitio.",
      });
      return;
    }
    setState({ step: "done", outcome, note });
    requestAnimationFrame(() => status.current?.focus());
  }

  const headline =
    state.step === "done"
      ? state.outcome === "kept"
        ? `Ya tenías el sello de «${title}».`
        : state.outcome === "upgraded"
          ? `Tu sello de «${title}» ahora es con ubicación.`
          : `¡Sellado! Ya tienes el sello de «${title}».`
      : null;

  return (
    <section className="stamp-collector" aria-labelledby="sello-titulo">
      <h2 id="sello-titulo" className="visually-hidden">
        Sellar
      </h2>
      {existing && state.step !== "done" ? (
        <p className="stamp-existing">
          Ya tienes el sello de este lugar: {stampWords(existing).replace(/^Sellado/u, "sellado")}.
        </p>
      ) : null}

      {state.step === "done" ? (
        <div className="stamp-result" data-outcome={state.outcome}>
          <p className="stamp-headline" ref={status} tabIndex={-1}>
            {headline}
          </p>
          {state.outcome === "kept" ? (
            <p>Se conserva el primero que conseguiste.</p>
          ) : (
            <p>{noteText(state.note)}</p>
          )}
        </div>
      ) : passport === undefined ? (
        // Rendered on the server: what this phone has is known only in the browser.
        <div className="stamp-actions" />
      ) : existing?.located ? null : (
        <div className="stamp-actions">
          {canLocate ? (
            <button
              type="button"
              className="portal-button stamp-primary"
              onClick={() => void stamp(true)}
              disabled={busy}
            >
              {existing ? "Sellar de nuevo con mi ubicación" : "Sellar con mi ubicación"}
            </button>
          ) : null}
          {existing ? null : (
            <button
              type="button"
              className={canLocate ? "stamp-secondary" : "portal-button stamp-primary"}
              onClick={() => void stamp(false)}
              disabled={busy}
            >
              {canLocate ? "Sellar sin compartir mi ubicación" : "Sellar"}
            </button>
          )}
          <p className="stamp-hint">
            {canLocate
              ? "Con tu ubicación, el sello queda «con ubicación». Tu posición no sale del teléfono: solo se envía si estás o no en el lugar."
              : "El sello queda «sin ubicación»: este navegador no puede usarla aquí."}
          </p>
        </div>
      )}

      <p className="stamp-status" role="status" aria-live="polite">
        {state.step === "locating"
          ? "Buscando tu ubicación…"
          : state.step === "sending"
            ? "Sellando…"
            : state.step === "error"
              ? state.message
              : ""}
      </p>

      {circuits.length > 0 && (existing || state.step === "done") ? (
        <ul className="stamp-circuits">
          {circuits.map((circuit) => {
            const progress = circuitProgress(circuit.stopIds, passport?.stamps ?? {});
            return (
              <li key={circuit.slug} data-complete={progress.complete}>
                <a href={circuit.href}>{circuit.name}</a>:{" "}
                {progress.complete ? (
                  circuit.reward ? (
                    <>
                      ¡completaste el circuito! Premio: {sentence(circuit.reward)}{" "}
                      <a href={`${circuit.href}#premio`}>Pedir mi premio</a>
                    </>
                  ) : (
                    "¡completaste el circuito!"
                  )
                ) : (
                  `${progress.collected} de ${progress.total} sellos.`
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="stamp-passport-link">
        <a href={passportHref}>Ver mi pasaporte</a>
      </p>
    </section>
  );
}
