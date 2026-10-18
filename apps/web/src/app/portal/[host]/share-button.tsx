"use client";

import { useState } from "react";

/**
 * Shares the page with the phone's share sheet; where there is none (most desktops),
 * copies the link instead. The result is announced to screen readers.
 */
export function ShareButton({ title, url }: { readonly title: string; readonly url: string }) {
  const [message, setMessage] = useState("");

  async function share() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Enlace copiado");
    } catch {
      setMessage("No se pudo copiar. Copia la dirección desde la barra del navegador.");
    }
  }

  return (
    <>
      <button type="button" className="portal-button" onClick={share}>
        Compartir
      </button>
      <span className="portal-status" role="status">
        {message}
      </span>
    </>
  );
}
