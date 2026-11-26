import { PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { publishedWebLinkReader } from "@/server/platform";
import { portalDestination, portalEvent, responsiveImage } from "@/server/portal-content";
import { portalHas, portalViewWith, type PortalView } from "@/server/portal-view";

import { AskShell, type AskPlace } from "../../../ask-shell";

interface AskPlacePageProps {
  readonly params: Promise<{ host: string; section: string; slug: string }>;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Rendered on its first visit and cached per host, like the portal's pages (ADR-024). */
export function generateStaticParams(): { section: string; slug: string }[] {
  return [];
}

/** The published place a QR names, with where its page is, or null (the portal's 404). */
async function placeOf(view: PortalView, section: string, slug: string): Promise<AskPlace | null> {
  if (!SLUG.test(slug) || slug.length > 80) return null;
  const kind = section === "destinos" ? "destination" : section === "agenda" ? "event" : null;
  if (kind === null) return null;
  const item =
    kind === "destination" ? await portalDestination(view, slug) : await portalEvent(view, slug);
  if (!item) return null;
  const tenantId = view.context.tenant.tenantId;
  const portal = portalHas(view, "portal");
  const web = portal
    ? undefined
    : (
        await publishedWebLinkReader()
          .links(tenantId)
          .catch(() => new Map<string, string>())
      ).get(`${kind}:${slug}`);
  const pagePath =
    kind === "destination" ? PORTAL_PATHS.destination(slug) : PORTAL_PATHS.event(slug);
  return {
    kind,
    title: item.title,
    href: portal ? pagePath : (web ?? null),
    linkLabel: portal ? "Ver su ficha" : "Ver en la web del municipio",
    image: item.cover ? responsiveImage(tenantId, item.cover) : null,
    pagePath,
  };
}

export async function generateMetadata({ params }: AskPlacePageProps): Promise<Metadata> {
  const { host, section, slug } = await params;
  const view = await portalViewWith(host, "assistant");
  if (view === null) return {};
  const place = await placeOf(view, section, slug);
  const name = view.resolved.presentation.assistant?.name.trim();
  const who = name ? `Pregúntale a ${name}` : "Pregúntale al asistente";
  return { title: place ? `${who} sobre «${place.title}»` : who };
}

/** «Pregúntale a …» about one place (ADR-071): what its QR on a sign opens. */
export default async function AskPlacePage({ params }: AskPlacePageProps) {
  const { host, section, slug } = await params;
  const view = await portalViewWith(host, "assistant");
  if (view === null) notFound();
  const place = await placeOf(view, section, slug);
  if (place === null) notFound();
  return <AskShell view={view} place={place} />;
}
