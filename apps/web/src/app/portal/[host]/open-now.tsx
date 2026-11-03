"use client";

import "./hours.css";

import { describeOpenState, localClock, openStateAt, type OpeningHours } from "@rikuy/core/geo";
import { useSyncExternalStore } from "react";

/**
 * «Abierto ahora · cierra a las 18:00» (ADR-039), computed in the browser: the page is
 * cached (ISR), so the server cannot know the minute it is read. The line keeps its space
 * before it is known, so nothing moves when it appears.
 */

const MINUTE = 60_000;

function subscribe(listener: () => void) {
  const timer = window.setInterval(listener, MINUTE);
  return () => window.clearInterval(timer);
}

const minute = () => Math.floor(Date.now() / MINUTE);

export function OpenNow({
  hours,
  timezone,
}: {
  readonly hours: OpeningHours;
  readonly timezone: string;
}) {
  const now = useSyncExternalStore(subscribe, minute, () => null);
  const state =
    now === null ? null : openStateAt(hours, localClock(new Date(now * MINUTE), timezone));
  const open = state !== null && (state.state === "open" || state.state === "always");
  return (
    <p className="portal-open-now" data-open={state === null ? undefined : open} role="status">
      {state === null ? " " : describeOpenState(state)}
    </p>
  );
}
