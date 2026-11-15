"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { ResponsiveImage } from "@/server/portal-content";

import { PortalImage } from "./portal-image";

const GALLERY_SIZES = "(min-width: 72rem) 15rem, (min-width: 40rem) 30vw, 50vw";

/**
 * The page's photos (C3 · Paso 4, ADR-063). Each one is a link to its largest derivative, so
 * without JavaScript it still opens; with it, the photo opens large on the same page, in a
 * native modal dialog («Foto 2 de 5», «Anterior», «Siguiente», arrows and Escape; after the
 * last photo comes the first). Closing
 * returns the focus to the photo that opened it.
 */
export function PhotoGallery({ photos }: { readonly photos: readonly ResponsiveImage[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const links = useRef<(HTMLAnchorElement | null)[]>([]);
  // The photo that opened the dialog gets the focus back when it closes.
  const opener = useRef<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const current = open === null ? null : (photos[open] ?? null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open !== null && !element.open) element.showModal();
    if (open === null && element.open) element.close();
  }, [open]);

  function show(index: number, event: MouseEvent<HTMLAnchorElement>) {
    // A new tab or window keeps the browser's own behavior.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    opener.current = index;
    setOpen(index);
  }

  /** Past the last photo comes the first again (no button is ever disabled under the focus). */
  function step(by: number) {
    setOpen((index) => (index === null ? null : (index + by + photos.length) % photos.length));
  }

  function keys(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
  }

  return (
    <section aria-labelledby="galeria" className="portal-gallery">
      <h2 id="galeria">Fotos</h2>
      <ul>
        {photos.map((photo, index) => (
          <li key={`${photo.src}-${index}`}>
            <a
              ref={(element) => {
                links.current[index] = element;
              }}
              href={photo.largest.url}
              className="portal-gallery-link"
              aria-label={`Ver la foto ${index + 1} de ${photos.length} en grande: ${photo.alt}`}
              onClick={(event) => show(index, event)}
            >
              <PortalImage image={photo} sizes={GALLERY_SIZES} />
            </a>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialog}
        className="portal-lightbox"
        aria-labelledby="galeria-foto"
        onKeyDown={keys}
        onClose={() => {
          setOpen(null);
          const index = opener.current;
          opener.current = null;
          if (index !== null) links.current[index]?.focus();
        }}
        onClick={(event) => {
          // A click on the backdrop (outside the content) closes it.
          if (event.target === event.currentTarget) setOpen(null);
        }}
      >
        {current && open !== null ? (
          <div className="portal-lightbox-body">
            <div className="portal-lightbox-bar">
              <p id="galeria-foto" className="portal-lightbox-count">
                Foto {open + 1} de {photos.length}
              </p>
              <button
                type="button"
                className="portal-button"
                autoFocus
                onClick={() => setOpen(null)}
              >
                Cerrar
              </button>
            </div>
            <figure className="portal-lightbox-figure">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={current.src}
                src={current.largest.url}
                srcSet={current.srcSet}
                sizes="100vw"
                width={current.width}
                height={current.height}
                alt={current.alt}
              />
              <figcaption aria-hidden="true">{current.alt}</figcaption>
            </figure>
            {photos.length > 1 ? (
              <div className="portal-lightbox-nav">
                <button type="button" className="portal-button" onClick={() => step(-1)}>
                  Anterior
                </button>
                <button type="button" className="portal-button" onClick={() => step(1)}>
                  Siguiente
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
