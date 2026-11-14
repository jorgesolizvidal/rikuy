import { listPlatformTenants, MODULE_KEYS, MODULE_NAMES } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../../sign-out-button";
import { ModulesForm } from "./modules-form";

export const metadata: Metadata = { title: "Módulos del municipio" };

interface ModulesPageProps {
  readonly params: Promise<{ slug: string }>;
}

/** The operator turns a municipality's modules on or off (C3 · Paso 1, ADR-060). */
export default async function ModulesPage({ params }: ModulesPageProps) {
  const { gate, session } = await operatorContext();
  if (gate.status === "denied") notFound();
  if (gate.status !== "granted") redirect("/plataforma");

  const slug = (await params).slug;
  const tenant = (await listPlatformTenants(session.platform))?.find((t) => t.slug === slug);
  if (!tenant) notFound();
  // Read before the migration of ADR-060: everything.
  const current = tenant.modules ?? [...MODULE_KEYS];

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <header className="admin-header">
        <Link href="/plataforma" className="eyebrow">
          ← Plataforma
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Módulos de {tenant.displayName}</h1>
        <p className="lead">
          Lo que tiene su portal y su panel. Destinos, marca, miembros, estadísticas, uso del plan e
          informe mensual están siempre.
        </p>
        <p className="field-hint">
          Ahora:{" "}
          {current.length > 0
            ? current.map((key) => MODULE_NAMES[key]).join(", ")
            : "ningún módulo (solo destinos)"}
          .
        </p>
      </div>
      <ModulesForm tenantId={tenant.tenantId} displayName={tenant.displayName} current={current} />
    </main>
  );
}
