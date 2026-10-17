import { listMyOrganizations, ROLE_LABELS } from "@rikuy/core";
import Link from "next/link";

import { adminSession, requireAdminActor } from "@/server/admin-session";

import { SignOutButton } from "./sign-out-button";

export default async function AdminHomePage() {
  const actor = await requireAdminActor();
  const organizations = await listMyOrganizations(actor, (await adminSession()).memberships);

  return (
    <main className="shell">
      <header className="admin-header">
        <p className="eyebrow">Rikuy · panel central</p>
        <SignOutButton />
      </header>
      <h1 className="title title-sm">Tus municipios</h1>
      <p className="lead">Sesión iniciada como {actor.email}.</p>

      {organizations.length === 0 ? (
        <p className="notice" role="status">
          Tu cuenta no tiene acceso activo a ningún municipio. Si crees que es un error, pide una
          invitación al propietario del portal.
        </p>
      ) : (
        <ul className="org-list">
          {organizations.map((organization) => (
            <li key={organization.tenantId}>
              <Link href={`/o/${organization.slug}`} className="org-card">
                <span className="org-name">{organization.displayName}</span>
                <span className="org-role">{ROLE_LABELS[organization.role]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
