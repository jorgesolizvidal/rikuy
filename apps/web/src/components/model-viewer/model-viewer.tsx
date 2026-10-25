"use client";

import dynamic from "next/dynamic";

import type { ModelCanvasProps } from "./model-canvas";

export type { ModelCanvasHandle } from "./model-canvas";

/** three.js only loads when a viewer is shown (never in a page's initial bundle). */
export const ModelViewer = dynamic<ModelCanvasProps>(() => import("./model-canvas"), {
  ssr: false,
  loading: () => (
    <div className="model-canvas model-canvas-loading" aria-hidden="true">
      Cargando el visor 3D…
    </div>
  ),
});
