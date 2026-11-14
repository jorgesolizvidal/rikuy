import {
  canChangeCircuit,
  canSetRedeemPin,
  circuitPublishIssues,
  loadPassport,
  PORTAL_PATHS,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireModule } from "@/server/organization";
import { platformSettings } from "@/server/platform";

import { SignOutButton } from "../../../../sign-out-button";
import { PortalShare } from "../../destinos/[id]/portal-share";
import { CircuitEditor } from "./circuit-editor";
import { RedeemPinForm } from "./redeem-pin";

export const metadata: Metadata = { title: "Circuito del pasaporte" };

interface CircuitPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

export default async function CircuitAdminPage({ params }: CircuitPageProps) {
  const { slug, id } = await params;
  const membership = await requireModule(slug, "passport");
  const session = await adminSession();
  const [view, hostname, pins] = await Promise.all([
    loadPassport(membership, { passport: session.passport, content: session.content }),
    session.content.portalHostname(membership.tenantId),
    session.rewards.pins(membership.tenantId),
  ]);
  const circuit = view.circuits.find((item) => item.id === id);
  if (!circuit) notFound();
  const canChange = canChangeCircuit(membership.role, circuit);
  const pinSetAt = pins.find((pin) => pin.circuitId === circuit.id)?.pinSetAt ?? null;
  const redeemUrl = hostname
    ? `${platformSettings().portalOrigin(hostname)}${PORTAL_PATHS.redeem}`
    : null;

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
      <section aria-labelledby="premio-y-canje" className="redeem-section">
        <h2 id="premio-y-canje">Premio y canje</h2>
        {circuit.reward ? (
          <>
            <p className="field-hint">
              Quien completa el circuito pide en el portal un comprobante con un código. El local
              que entrega el premio lo canjea en{" "}
              {redeemUrl ? (
                <a href={redeemUrl}>{redeemUrl}</a>
              ) : (
                "la página «Canjear un premio» del portal"
              )}{" "}
              con ese código y la clave del local. Cada comprobante vale 30 días y se canjea una
              sola vez.
            </p>
            <p className={pinSetAt ? "field-hint" : "notice"}>
              {pinSetAt
                ? `Clave del local guardada el ${new Date(pinSetAt).toLocaleDateString("es-BO", { day: "numeric", month: "long", year: "numeric", timeZone: "America/La_Paz" })}.`
                : "Este circuito todavía no tiene clave del local: sin ella, los comprobantes no se pueden canjear."}
            </p>
            {canSetRedeemPin(membership.role) ? (
              <RedeemPinForm
                org={membership.slug}
                circuitId={circuit.id}
                hasPin={pinSetAt !== null}
              />
            ) : null}
          </>
        ) : (
          <p className="field-hint">
            Este circuito no tiene premio: escribe uno arriba para que quien lo complete pueda
            pedirlo.
          </p>
        )}
      </section>
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
