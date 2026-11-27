import { assistantPersona, helpDeskOf, monogram } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { aiGatewayStatus } from "@/server/ai-gateway";
import { portalHas, portalViewWith } from "@/server/portal-view";

import { AssistantInFrame } from "../assistant-on-page";

interface EmbedPageProps {
  readonly params: Promise<{ host: string }>;
}

export const metadata: Metadata = { title: "Asistente" };

/**
 * The frame the municipality's website shows (ADR-071). Only its authorized websites may show
 * it (frame-ancestors, set by the proxy); the place a page of the website is about comes in
 * `?lugar=` and is read in the browser, so this page stays cached per host.
 */
export default async function EmbedPage({ params }: EmbedPageProps) {
  const view = await portalViewWith((await params).host, "assistant");
  if (view === null) notFound();
  const { presentation } = view.resolved;
  const persona = assistantPersona(presentation);
  if (!aiGatewayStatus().configured) {
    return (
      <p className="ask-unavailable ask-embed-unavailable" role="status">
        El asistente no está disponible por ahora.
      </p>
    );
  }
  return (
    <AssistantInFrame
      name={persona.name}
      named={persona.named}
      greeting={persona.greeting}
      siteName={presentation.identity.siteName}
      logo={view.logo?.webp ?? null}
      mark={monogram(presentation.identity.shortName)}
      voice={portalHas(view, "voice")}
      helpDesk={helpDeskOf(presentation)}
      timezone={view.context.tenant.timezone}
    />
  );
}
