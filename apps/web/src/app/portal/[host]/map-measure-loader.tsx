"use client";

import dynamic from "next/dynamic";

/** `/mapa?medir` (Hito · Paso 3): the panel's code is downloaded only then. */
const MapMeasure = dynamic(() => import("./map-measure"), { ssr: false });

export function MapMeasureLoader() {
  return <MapMeasure />;
}
