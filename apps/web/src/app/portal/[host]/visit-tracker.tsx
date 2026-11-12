"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { QR_PARAM, sendVisit, type VisitEventName } from "@/lib/visit-beacon";

const ACTIONS: readonly VisitEventName[] = ["directions", "share", "calendar"];

/**
 * Counts what the visitor opens (ADR-051): each page, once per address (also the tours the
 * general tour jumps to), and a printed QR code (`?qr=1`), whose mark it then removes from the
 * address so a shared link does not count as a scan. Clicks on controls marked `data-visit`
 * («Cómo llegar», «Compartir», «Añadir al calendario») count too. Renders nothing.
 */
export function VisitTracker() {
  const pathname = usePathname();

  useEffect(() => {
    const url = new URL(window.location.href);
    sendVisit("view", url.pathname);
    if (url.searchParams.has(QR_PARAM)) {
      sendVisit("qr", url.pathname);
      url.searchParams.delete(QR_PARAM);
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  }, [pathname]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target.closest("[data-visit]") : null;
      const action = target?.getAttribute("data-visit") as VisitEventName | null;
      if (action && ACTIONS.includes(action)) sendVisit(action, window.location.pathname);
    }
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  return null;
}
