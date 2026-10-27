"use client";

import dynamic from "next/dynamic";

import type { TourCanvasProps } from "./tour-canvas";

export type { TourCanvasHandle, TourCanvasScene } from "./tour-canvas";

/** The portal's tour viewer, loaded only on a tour page (never in an initial bundle). */
export const TourViewer = dynamic<TourCanvasProps>(() => import("./tour-canvas"), {
  ssr: false,
  loading: () => <div className="panorama-canvas tour-canvas" aria-hidden="true" />,
});
