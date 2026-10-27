"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RichTextView } from "@/components/rich-text";
import {
  ModelViewer,
  type ModelCanvasFailure,
  type ModelCanvasHandle,
} from "@/components/model-viewer/model-viewer";

import type { TourPointDto } from "./tour-dto";

/**
 * A model point in the tour (P4 · Paso 6, ADR-033): its poster first, and the 3D viewer only
 * when the visitor asks for it. Until then, neither three.js nor the GLB is downloaded (RC-08).
 *
 * - "Ver en 3D" loads the viewer over the poster, with its progress; the poster stays until
 *   the model is on screen, so the box never jumps.
 * - "Volver a la imagen" (or closing the dialog) frees the model, its textures and the WebGL
 *   context; opening it again starts over (the GLB then comes from the browser's cache).
 * - A file that does not load offers "Reintentar"; a lost WebGL context (a phone short of
 *   video memory) goes back to the poster with a notice; without WebGL the poster and the
 *   description are the model.
 * - The description, written by the municipality, is the text alternative, with how to use
 *   the viewer with a pointer and with the keyboard.
 */
type ModelPoint = Extract<TourPointDto, { kind: "model" }>;

type State =
  | { readonly step: "poster" }
  | { readonly step: "loading"; readonly attempt: number; readonly progress: number | null }
  | { readonly step: "ready"; readonly attempt: number }
  | { readonly step: "failed"; readonly reason: ModelCanvasFailure };

const FAILURE: Record<ModelCanvasFailure, string> = {
  load: "No se pudo descargar el modelo 3D. Revisa tu conexión e inténtalo de nuevo.",
  context:
    "El visor 3D se cerró porque el dispositivo necesitó su memoria. Puedes volver a abrirlo.",
  webgl: "Este navegador no puede mostrar modelos 3D. Aquí tienes su imagen y su descripción.",
};

/** Progress read aloud in steps of a quarter, not on every chunk. */
function spokenProgress(progress: number | null): string {
  if (progress === null) return "Cargando el modelo 3D…";
  return `Cargando el modelo 3D: ${Math.floor((progress * 100) / 25) * 25} %`;
}

export function TourModel({ point }: { readonly point: ModelPoint }) {
  const [state, setState] = useState<State>({ step: "poster" });
  const handle = useRef<ModelCanvasHandle | null>(null);
  const mainButton = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  /** Where the focus goes after the next render: the canvas or the main button. */
  const focusNext = useRef<"canvas" | "button" | null>(null);
  const nextAttempt = useRef(0);

  const open = useCallback(() => {
    nextAttempt.current += 1;
    setState({ step: "loading", attempt: nextAttempt.current, progress: null });
  }, []);
  const close = useCallback(() => {
    handle.current = null;
    focusNext.current = "button";
    setState({ step: "poster" });
  }, []);

  const onReady = useCallback((ready: ModelCanvasHandle) => {
    handle.current = ready;
    focusNext.current = "canvas";
    setState((current) =>
      current.step === "loading" ? { step: "ready", attempt: current.attempt } : current,
    );
  }, []);
  const onProgress = useCallback((progress: number) => {
    setState((current) => (current.step === "loading" ? { ...current, progress } : current));
  }, []);
  const onFailure = useCallback((reason: ModelCanvasFailure) => {
    handle.current = null;
    focusNext.current = "button";
    setState({ step: "failed", reason });
  }, []);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === "canvas") stage.current?.querySelector("canvas")?.focus();
    // Without WebGL there is no button left: the focus goes to the message.
    else (mainButton.current ?? status.current)?.focus();
  }, [state.step]);

  const viewing = state.step === "loading" || state.step === "ready";
  const ready = state.step === "ready";
  const label = `Modelo 3D «${point.title}». Arrástralo para girarlo; con el teclado, flechas para girar y + o − para acercar.`;
  const hintId = `tour-model-hint-${point.id}`;

  return (
    <div className="tour-model">
      <div
        ref={stage}
        className="tour-model-stage"
        data-state={state.step}
        style={{ aspectRatio: `${point.poster.width} / ${point.poster.height}` }}
      >
        <figure className="tour-model-poster" hidden={ready}>
          {/* eslint-disable-next-line @next/next/no-img-element -- published, versioned derivative */}
          <img
            src={point.poster.url}
            width={point.poster.width}
            height={point.poster.height}
            alt={`Imagen del modelo 3D «${point.title}»`}
          />
        </figure>
        {viewing ? (
          // Out of reach (focus, screen readers) until the model is on screen.
          <div className="tour-model-viewer" inert={!ready}>
            <ModelViewer
              key={state.attempt}
              url={point.model.url}
              label={label}
              capturable={false}
              onReady={onReady}
              onProgress={onProgress}
              onFailure={onFailure}
            />
          </div>
        ) : null}
        {state.step === "loading" ? (
          <div className="tour-model-progress" aria-hidden="true">
            <progress max={1} value={state.progress ?? undefined} />
          </div>
        ) : null}
      </div>

      <p ref={status} tabIndex={-1} className="tour-model-status" role="status" aria-live="polite">
        {state.step === "loading"
          ? spokenProgress(state.progress)
          : state.step === "ready"
            ? "Modelo 3D listo."
            : state.step === "failed"
              ? FAILURE[state.reason]
              : ""}
      </p>

      <div className="tour-model-actions">
        {state.step === "failed" && state.reason === "webgl" ? null : (
          <button
            ref={mainButton}
            type="button"
            className="portal-button tour-model-open"
            aria-describedby={ready ? undefined : hintId}
            onClick={viewing ? close : open}
          >
            {state.step === "loading"
              ? "Cancelar"
              : state.step === "ready"
                ? "Volver a la imagen"
                : state.step === "failed"
                  ? state.reason === "load"
                    ? "Reintentar"
                    : "Volver a abrir en 3D"
                  : "Ver en 3D"}
          </button>
        )}
        {ready ? (
          <button
            type="button"
            className="portal-button"
            onClick={() => {
              handle.current?.resetView();
              stage.current?.querySelector("canvas")?.focus();
            }}
          >
            Restablecer vista
          </button>
        ) : null}
      </div>
      <p id={hintId} className="tour-model-hint">
        Descarga de {point.model.size}
        {point.model.heavy ? ": es un modelo pesado y con datos móviles puede tardar" : ""}.
        {ready || state.step === "loading"
          ? " Arrastra para girarlo y pellizca o usa la rueda para acercarlo. Con el teclado, en el modelo: flechas para girar, + y − para acercar, Inicio para volver a la primera vista."
          : null}
      </p>

      {point.body.length > 0 ? (
        <section
          className="portal-prose tour-model-description"
          aria-label="Descripción del modelo"
        >
          <RichTextView blocks={point.body} />
        </section>
      ) : null}
    </div>
  );
}
