import { canEditContent, canManageBranding, canManageMembers, ROLE_LABELS } from "@rikuy/core";
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
    <main id="contenido" tabIndex={-1} className="shell">
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
          <Link href={`/o/${membership.slug}/destinos`} className="org-card">
            <span>
              <span className="org-name">Destinos</span>
              <span className="org-detail">Lugares para visitar: texto, ubicación y fotos</span>
            </span>
            <span className="org-role">{canEditContent(membership.role) ? "Editar" : "Ver"}</span>
          </Link>
        </li>
        <li>
          <Link href={`/o/${membership.slug}/agenda`} className="org-card">
            <span>
              <span className="org-name">Agenda</span>
              <span className="org-detail">Eventos con fecha, lugar y fotos</span>
            </span>
            <span className="org-role">{canEditContent(membership.role) ? "Editar" : "Ver"}</span>
          </Link>
        </li>
        <li>
          <Link href={`/o/${membership.slug}/panoramas`} className="org-card">
            <span>
              <span className="org-name">Panoramas 360°</span>
              <span className="org-detail">Fotos 360° para los recorridos virtuales</span>
            </span>
            <span className="org-role">{canEditContent(membership.role) ? "Subir" : "Ver"}</span>
          </Link>
        </li>
        <li>
          <Link href={`/o/${membership.slug}/modelos`} className="org-card">
            <span>
              <span className="org-name">Modelos 3D</span>
              <span className="org-detail">
                Objetos en 3D para los recorridos, optimizados para celulares
              </span>
            </span>
            <span className="org-role">{canEditContent(membership.role) ? "Subir" : "Ver"}</span>
          </Link>
        </li>
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
        {canManageMembers(membership.role) ? (
          <li>
            <Link href={`/o/${membership.slug}/miembros`} className="org-card">
              <span>
                <span className="org-name">Miembros</span>
                <span className="org-detail">Invitar personas, cambiar roles y quitar accesos</span>
              </span>
              <span className="org-role">Gestionar</span>
            </Link>
          </li>
        ) : null}
      </ul>
      <p className="notice">
        Los recorridos 360° llegarán en una próxima etapa; sus panoramas y modelos 3D ya se pueden
        subir.
      </p>
    </main>
  );
}
