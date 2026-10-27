"use client";

import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";
import "./hotspot-markers.css";

import { Viewer } from "@photo-sphere-viewer/core";
import { MarkersPlugin } from "@photo-sphere-viewer/markers-plugin";
import { useEffect, useRef } from "react";

import type { HotspotMarker } from "./hotspot-markers";
import {
  accessibleViewer,
  fovOf,
  markerConfig,
  MAX_FOV,
  MIN_FOV,
  VIEWER_LANG,
  webglAvailable,
  zoomLevelOf,
} from "./viewer-shared";

/**
 * The 360° viewer (Photo Sphere Viewer 5, on the app's single three.js). Always loaded
 * with next/dynamic (ssr: false), so it never enters a page's initial bundle. The panel's
 * editor (one image per scene); the portal has its own (tour-canvas.tsx) with the same
 * angles: yaw/pitch in radians and the field of view in degrees.
 *
 * Keyboard: the arrows and +/- move the view only while the viewer has focus (the page's
 * own keys keep working elsewhere).
 */
export interface PanoramaView {
  readonly yaw: number;
  readonly pitch: number;
  readonly fov: number;
}

export interface PanoramaCanvasHandle {
  currentView(): PanoramaView;
  goTo(view: PanoramaView): void;
  /** Turns the view to a point (yaw/pitch) without changing the zoom. */
  lookAt(point: { readonly yaw: number; readonly pitch: number }): void;
}

export interface PanoramaCanvasProps {
  readonly url: string;
  /** Blurred preview shown while the image loads. */
  readonly previewUrl?: string | null | undefined;
  readonly initialView: PanoramaView;
  /** Accessible name of the viewer (the page gives the text alternative next to it). */
  readonly label: string;
  readonly onReady?: ((handle: PanoramaCanvasHandle) => void) | undefined;
  /** WebGL or the image could not load: the page says so and keeps working. */
  readonly onFailure?: (() => void) | undefined;
  /** The scene's points. */
  readonly markers?: readonly HotspotMarker[] | undefined;
  readonly onMarkerSelect?: ((id: string) => void) | undefined;
  /** While true, a click on the panorama reports where (to place or move a point). */
  readonly picking?: boolean | undefined;
  readonly onPick?: ((point: { yaw: number; pitch: number }) => void) | undefined;
}

export default function PanoramaCanvas({
  url,
  previewUrl,
  initialView,
  label,
  onReady,
  onFailure,
  markers,
  onMarkerSelect,
  picking,
  onPick,
}: PanoramaCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onFailure, onMarkerSelect, onPick });
  const start = useRef(initialView);
  const plugin = useRef<MarkersPlugin | null>(null);
  const pickingRef = useRef(picking ?? false);
  const markersRef = useRef(markers ?? []);
  useEffect(() => {
    callbacks.current = { onReady, onFailure, onMarkerSelect, onPick };
    pickingRef.current = picking ?? false;
  }, [onReady, onFailure, onMarkerSelect, onPick, picking]);

  // The points follow the props (a cheap key: they change only after an edit).
  const markersKey = JSON.stringify(markers ?? []);
  useEffect(() => {
    markersRef.current = markers ?? [];
    plugin.current?.setMarkers(markersRef.current.map(markerConfig));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on their content
  }, [markersKey]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (!webglAvailable()) {
      callbacks.current.onFailure?.();
      return;
    }
    let viewer: Viewer;
    try {
      viewer = new Viewer({
        container: element,
        panorama: url,
        defaultYaw: start.current.yaw,
        defaultPitch: start.current.pitch,
        defaultZoomLvl: zoomLevelOf(start.current.fov),
        minFov: MIN_FOV,
        maxFov: MAX_FOV,
        navbar: ["zoom", "move", "fullscreen"],
        keyboard: false,
        mousewheelCtrlKey: true,
        touchmoveTwoFingers: false,
        loadingTxt: VIEWER_LANG.loading,
        lang: VIEWER_LANG,
        plugins: [[MarkersPlugin, { markers: markersRef.current.map(markerConfig) }]],
      });
      plugin.current = viewer.getPlugin(MarkersPlugin);
    } catch {
      callbacks.current.onFailure?.();
      return;
    }
    const container = viewer.container;
    const releaseAccessibility = accessibleViewer(viewer, label);

    viewer.addEventListener(
      "ready",
      () => {
        callbacks.current.onReady?.({
          currentView: () => {
            const position = viewer.getPosition();
            return { yaw: position.yaw, pitch: position.pitch, fov: fovOf(viewer.getZoomLevel()) };
          },
          goTo: (view) => {
            viewer.rotate({ yaw: view.yaw, pitch: view.pitch });
            viewer.zoom(zoomLevelOf(view.fov));
          },
          lookAt: (point) => viewer.rotate({ yaw: point.yaw, pitch: point.pitch }),
        });
      },
      { once: true },
    );
    viewer.addEventListener("panorama-error", () => callbacks.current.onFailure?.());
    // Placing a point: our own pointer handling, not the viewer's "click" (that one waits to
    // rule out a double click, and the markers plugin swallows it when it believes the
    // pointer is still over a point). A press that does not move counts as a pick.
    let pressed: { x: number; y: number } | null = null;
    const pointerDown = (event: PointerEvent) => {
      pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const pointerUp = (event: PointerEvent) => {
      const start = pressed;
      pressed = null;
      if (!pickingRef.current || !start) return;
      // The navbar's buttons (zoom, arrows) keep working while placing.
      if (event.target instanceof Element && event.target.closest(".psv-navbar")) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return; // a drag
      const box = container.getBoundingClientRect();
      const point = viewer.dataHelper.viewerCoordsToSphericalCoords({
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
      callbacks.current.onPick?.({ yaw: point.yaw, pitch: point.pitch });
    };
    container.addEventListener("pointerdown", pointerDown, true);
    container.addEventListener("pointerup", pointerUp, true);
    plugin.current?.addEventListener("select-marker", ({ marker }) => {
      if (pickingRef.current) return;
      callbacks.current.onMarkerSelect?.(marker.id);
    });

    return () => {
      releaseAccessibility();
      container.removeEventListener("pointerdown", pointerDown, true);
      container.removeEventListener("pointerup", pointerUp, true);
      plugin.current = null;
      viewer.destroy();
    };
  }, [url, label]);

  return (
    <div
      ref={host}
      className="panorama-canvas"
      data-picking={picking ? "true" : undefined}
      style={previewUrl ? { backgroundImage: `url("${previewUrl}")` } : undefined}
    />
  );
}
