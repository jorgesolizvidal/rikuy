"use client";

import { describeCountdown, eventCountdown, type CountdownEvent } from "@rikuy/core/geo";
import { useSyncExternalStore } from "react";

/**
 * «Hoy a las 19:00», «Mañana», «En 5 días», «En curso» (C3 · Paso 4, ADR-063), computed in the
 * browser with the municipality's clock: the page is cached, so the server cannot know the
 * minute it is read. The line keeps its space before it is known, so nothing moves.
 */

const MINUTE = 60_000;

function subscribe(listener: () => void) {
  const timer = window.setInterval(listener, MINUTE);
  return () => window.clearInterval(timer);
}

const minute = () => Math.floor(Date.now() / MINUTE);

export function EventStatus({
  event,
  timezone,
}: {
  readonly event: CountdownEvent;
  readonly timezone: string;
}) {
  const now = useSyncExternalStore(subscribe, minute, () => null);
  const countdown = now === null ? null : eventCountdown(event, new Date(now * MINUTE), timezone);
  const text = countdown === null ? null : describeCountdown(countdown);
  return (
    <p className="portal-event-status" data-state={countdown?.state} role="status">
      {text === null ? " " : <span className="portal-event-status-pill">{text}</span>}
    </p>
  );
}
