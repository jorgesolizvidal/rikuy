"use client";

import { parseEmbedPlace, type HelpDeskContact } from "@rikuy/core/assistant-client";
import dynamic from "next/dynamic";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The assistant on its own page or inside the municipality's website (ADR-071). The
 * conversation lives in the browser (ADR-038), so the panel is rendered there only.
 */
const AssistantPanel = dynamic(() => import("../../portal/[host]/assistant-panel"), {
  ssr: false,
  loading: () => <p className="ask-loading">Abriendo el asistente…</p>,
});

export interface AssistantOnPageProps {
  readonly name: string;
  readonly named: boolean;
  readonly greeting: string;
  readonly siteName: string;
  readonly logo: string | null;
  readonly mark: string;
  readonly voice: boolean;
  /** «Hablar con una persona» (ADR-073). */
  readonly helpDesk: HelpDeskContact | null;
  readonly timezone: string;
}

/** «Pregúntale a …»: open in the page, about the place its QR names (if any). */
export function AssistantOnPage({
  pagePath,
  ...props
}: AssistantOnPageProps & { readonly pagePath: string | null }) {
  return <AssistantPanel {...props} open mode="page" pagePath={pagePath} />;
}

const noSubscription = () => () => undefined;

/** The place the website's page is about (`?lugar=destinos/…`), checked like the server would. */
function placeFromAddress(): string | null {
  const place = parseEmbedPlace(new URLSearchParams(window.location.search).get("lugar"));
  return place ? `/${place.kind === "destination" ? "destinos" : "agenda"}/${place.slug}` : null;
}

/** The website's frame: closing it tells the website, which hides the frame. */
export function AssistantInFrame(props: AssistantOnPageProps) {
  const pagePath = useSyncExternalStore(noSubscription, placeFromAddress, () => null);
  const close = useCallback(() => {
    window.parent.postMessage({ type: "rikuy:close" }, "*");
  }, []);
  return <AssistantPanel {...props} open mode="embed" pagePath={pagePath} onClose={close} />;
}
