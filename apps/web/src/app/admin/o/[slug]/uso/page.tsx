import { loadUsage } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { UsageBar } from "@/components/usage/usage-bar";
import { RESOURCE_DETAILS, RESOURCE_LABELS } from "@/components/usage/usage-format";
import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";

export const metadata: Metadata = { title: "Uso del plan" };

interface UsagePageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function UsagePage({ params }: UsagePageProps) {
  const membership = await requireOrganization((await params).slug);
  const meters = await loadUsage(membership, (await adminSession()).usage);

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Uso del plan</h1>
        <p className="lead">
          Cuánto usa {membership.displayName} de lo que tiene asignado. Cuando algo llega a su
          límite, se rechazan las subidas nuevas; no se borra nada de lo que ya está.
        </p>
      </div>

      <ul className="usage-list">
        {meters.map((meter) => (
          <li key={meter.resource} className="usage-card">
            <h2>{RESOURCE_LABELS[meter.resource]}</h2>
            <p className="field-hint">{RESOURCE_DETAILS[meter.resource]}</p>
            <UsageBar meter={meter} />
            {meter.resource === "media_compute_seconds" ? (
              <p className="field-hint">Se renueva el día 1 de cada mes.</p>
            ) : null}
            {meter.level === "full" ? (
              <p className="notice" role="status">
                Llegó a su límite: las subidas nuevas que lo necesiten se rechazan. Pide al equipo
                de la plataforma que lo amplíe.
              </p>
            ) : meter.level === "near" ? (
              <p className="notice" role="status">
                Ya usa más del 80 %. Si van a subir más, conviene pedir que lo amplíen.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="field-hint">
        Lo «reservado» es una estimación de lo que están subiendo o procesando ahora; se ajusta a lo
        real cuando termina.
      </p>
    </main>
  );
}
