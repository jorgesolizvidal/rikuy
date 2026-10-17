import { canManageBranding, ROLE_LABELS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../sign-out-button";

interface OrganizationPageProps {
  readonly params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: OrganizationPageProps): Promise<Metadata> {
  return { title: (await requireOrganization((await params).slug)).displayName };
}

export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const membership = await requireOrganization((await params).slug);

  return (
    <main className="shell">
      <header className="admin-header">
        <Link href="/" className="eyebrow">
          ← Tus municipios
        </Link>
        <SignOutButton />
      </header>
      <h1 className="title title-sm">{membership.displayName}</h1>
      <p className="lead">Tu rol: {ROLE_LABELS[membership.role]}.</p>
      <ul className="org-list">
        <li>
          <Link href={`/o/${membership.slug}/configuracion`} className="org-card">
            <span>
              <span className="org-name">Marca del portal</span>
              <span className="org-detail">Nombre, colores, contacto y redes sociales</span>
            </span>
            <span className="org-role">
              {canManageBranding(membership.role) ? "Editar" : "Ver"}
            </span>
          </Link>
        </li>
      </ul>
      <p className="notice">
        Destinos, agenda, recorridos 360° y medios llegarán en las siguientes etapas.
      </p>
    </main>
  );
}
