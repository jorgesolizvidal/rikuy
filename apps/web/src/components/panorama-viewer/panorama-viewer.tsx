"use client";

import dynamic from "next/dynamic";

import type { PanoramaCanvasProps } from "./panorama-canvas";

export type { PanoramaCanvasHandle, PanoramaView } from "./panorama-canvas";

/** Photo Sphere Viewer only loads when a viewer is shown (never in a page's initial bundle). */
export const PanoramaViewer = dynamic<PanoramaCanvasProps>(() => import("./panorama-canvas"), {
  ssr: false,
  loading: () => (
    <div className="panorama-canvas panorama-canvas-loading" aria-hidden="true">
      Cargando la vista 360°…
    </div>
  ),
});
