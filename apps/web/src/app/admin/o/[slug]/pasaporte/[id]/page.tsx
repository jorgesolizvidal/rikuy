import { canChangeCircuit, circuitPublishIssues, loadPassport, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";
import { platformSettings } from "@/server/platform";

import { SignOutButton } from "../../../../sign-out-button";
import { PortalShare } from "../../destinos/[id]/portal-share";
import { CircuitEditor } from "./circuit-editor";

export const metadata: Metadata = { title: "Circuito del pasaporte" };

interface CircuitPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

export default async function CircuitAdminPage({ params }: CircuitPageProps) {
  const { slug, id } = await params;
  const membership = await requireOrganization(slug);
  const session = await adminSession();
  const [view, hostname] = await Promise.all([
    loadPassport(membership, { passport: session.passport, content: session.content }),
    session.content.portalHostname(membership.tenantId),
  ]);
  const circuit = view.circuits.find((item) => item.id === id);
  if (!circuit) notFound();
  const canChange = canChangeCircuit(membership.role, circuit);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/pasaporte`} className="eyebrow">
          ← Pasaporte turístico
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">{circuit.name}</h1>
        <p className="lead">
          <span className="status-pill" data-status={circuit.status}>
            {circuit.status === "published" ? "Publicado" : "Borrador"}
          </span>{" "}
          Dirección en el portal: {PORTAL_PATHS.passportCircuit(circuit.slug)}
        </p>
      </div>
      {!canChange ? (
        <p className="notice" role="status">
          {view.canEdit
            ? "Este circuito está publicado: solo propietarios y administradores lo cambian."
            : "Tu rol puede ver el circuito, pero no cambiarlo."}
        </p>
      ) : null}
      <CircuitEditor
        org={membership.slug}
        circuit={circuit}
        destinations={view.destinations}
        canChange={canChange}
        canPublish={view.canPublish}
        issues={circuitPublishIssues(circuit)}
      />
      {circuit.status === "published" && hostname ? (
        <PortalShare
          url={`${platformSettings().portalOrigin(hostname)}${PORTAL_PATHS.passportCircuit(circuit.slug)}`}
          slug={`pasaporte-${circuit.slug}`}
          title={circuit.name}
          portalOnline={membership.tenantStatus === "active"}
          opens="este circuito"
        />
      ) : null}
    </main>
  );
}
