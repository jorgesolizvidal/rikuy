import { loadSampleContentStatus } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";
import { platformSettings } from "@/server/platform";

import { SignOutButton } from "../../../sign-out-button";
import { AutoRefresh } from "../panoramas/auto-refresh";
import { SamplePanel } from "./sample-panel";

export const metadata: Metadata = { title: "Contenido de muestra" };

interface SamplePageProps {
  readonly params: Promise<{ slug: string }>;
}

/** Only in a commercial demo, for its owners and administrators (ADR-034). */
export default async function SamplePage({ params }: SamplePageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const status = await loadSampleContentStatus(membership, {
    content: session.content,
    tours: session.tours,
    panoramas: session.panoramas,
  });
  if (status === null) notFound();
  const hostname = await session.content.portalHostname(membership.tenantId);
  const portalUrl = hostname ? platformSettings().portalOrigin(hostname) : null;

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <AutoRefresh active={status.tour === "processing"} />
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Contenido de muestra</h1>
        <p className="lead">
          Para la demostración: cinco destinos, tres eventos y un tour 360° de ejemplo, con
          ilustraciones y textos genéricos que llevan el nombre de {membership.displayName}. Todo se
          edita y se reemplaza como cualquier otro contenido.
        </p>
      </div>
      <SamplePanel
        slug={membership.slug}
        status={status}
        portalUrl={portalUrl}
        online={membership.tenantStatus === "active"}
      />
    </main>
  );
}
