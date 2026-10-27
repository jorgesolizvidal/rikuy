"use client";

import { useEffect, useRef, useState } from "react";

import { RichTextView } from "@/components/rich-text";

import { PortalImage } from "./portal-image";
import type { TourPointDto } from "./tour-dto";

/**
 * A point's dialog in the tour: information (text and its gallery, photo by photo) or a 3D
 * model (its poster; the model itself comes with P4 · Paso 6). A native <dialog>: it keeps
 * the focus inside, closes with Escape and gives the focus back to what opened it; it also
 * shows over the stage in fullscreen.
 */
const GALLERY_SIZES = "(min-width: 48rem) 44rem, 92vw";

export type OpenPoint = Extract<TourPointDto, { kind: "info" | "model" }>;

export function PointDialog({
  point,
  onClose,
}: {
  readonly point: OpenPoint | null;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [photo, setPhoto] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (point && !element.open) {
      setPhoto(0);
      element.showModal();
    } else if (!point && element.open) {
      element.close();
    }
  }, [point]);

  const gallery = point?.kind === "info" ? point.gallery : [];
  const image = gallery[Math.min(photo, gallery.length - 1)];
  return (
    <dialog
      ref={dialog}
      className="tour-dialog"
      aria-labelledby="tour-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop (outside the box) closes it.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      {point ? (
        <div className="tour-dialog-box">
          <header className="tour-dialog-header">
            <p className="tour-dialog-kind">
              {point.kind === "model" ? "Modelo 3D" : "Información"}
            </p>
            <h2 id="tour-dialog-title">{point.title}</h2>
            <button
              type="button"
              className="tour-dialog-close"
              onClick={() => dialog.current?.close()}
            >
              <span aria-hidden="true">×</span>
              <span className="visually-hidden">Cerrar</span>
            </button>
          </header>
          {point.kind === "info" ? (
            <>
              {point.body.length > 0 ? (
                <div className="portal-prose tour-dialog-body">
                  <RichTextView blocks={point.body} />
                </div>
              ) : null}
              {image ? (
                <figure className="tour-gallery" aria-roledescription="galería">
                  <PortalImage image={image} sizes={GALLERY_SIZES} priority />
                  {gallery.length > 1 ? (
                    <figcaption className="tour-gallery-controls">
                      <button
                        type="button"
                        className="portal-button"
                        disabled={photo === 0}
                        onClick={() => setPhoto((index) => Math.max(0, index - 1))}
                      >
                        Anterior
                      </button>
                      <span aria-live="polite">
                        Foto {photo + 1} de {gallery.length}
                      </span>
                      <button
                        type="button"
                        className="portal-button"
                        disabled={photo >= gallery.length - 1}
                        onClick={() => setPhoto((index) => Math.min(gallery.length - 1, index + 1))}
                      >
                        Siguiente
                      </button>
                    </figcaption>
                  ) : null}
                </figure>
              ) : null}
            </>
          ) : (
            <figure className="tour-model-poster">
              {/* eslint-disable-next-line @next/next/no-img-element -- published, versioned derivative */}
              <img
                src={point.poster.url}
                width={point.poster.width}
                height={point.poster.height}
                alt={`Imagen del modelo 3D «${point.title}»`}
              />
            </figure>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
