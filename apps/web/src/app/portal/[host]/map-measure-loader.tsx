"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";

/** `/mapa?medir` (Hito · Paso 3): the panel's code is downloaded only then. */
const MapMeasure = dynamic(() => import("./map-measure"), { ssr: false });

const noSubscription = () => () => undefined;
const requested = () => new URLSearchParams(window.location.search).has("medir");
const notOnServer = () => false;

/**
 * Read in the browser, like the tour's panel: in production an empty `?medir` never reaches
 * the server (`?medir=1` does), so a server-side check missed it.
 */
export function MapMeasureLoader() {
  const measure = useSyncExternalStore(noSubscription, requested, notOnServer);
  return measure ? <MapMeasure /> : null;
}
