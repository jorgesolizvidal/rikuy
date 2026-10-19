import { listMyInvitations, listMyOrganizations, ROLE_LABELS } from "@rikuy/core";
import Link from "next/link";

import { adminSession, requireAdminActor } from "@/server/admin-session";

import { AcceptInvitationButton } from "./accept-invitation-button";
import { SignOutButton } from "./sign-out-button";

export default async function AdminHomePage() {
  const actor = await requireAdminActor();
  const session = await adminSession();
  const [organizations, invitations, operator] = await Promise.all([
    listMyOrganizations(actor, session.memberships),
    listMyInvitations(session.invitations),
    session.platform.operatorAccess(),
  ]);

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <header className="admin-header">
        <p className="eyebrow">Rikuy · panel central</p>
        <SignOutButton />
      </header>
      <h1 className="title title-sm">Tus municipios</h1>
      <p className="lead">Sesión iniciada como {actor.email}.</p>

      {invitations.length > 0 ? (
        <section className="invitations" aria-labelledby="invitaciones">
          <h2 id="invitaciones">Invitaciones pendientes</h2>
          <ul className="org-list">
            {invitations.map((invitation) => (
              <li key={invitation.tenantId} className="org-card">
                <span>
                  <span className="org-name">{invitation.displayName}</span>
                  <span className="org-detail">
                    Te invitaron como {ROLE_LABELS[invitation.role]}
                  </span>
                </span>
                <AcceptInvitationButton tenantId={invitation.tenantId} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {organizations.length === 0 ? (
        invitations.length === 0 ? (
          <p className="notice" role="status">
            Tu cuenta no tiene acceso activo a ningún municipio. Si crees que es un error, pide una
            invitación al propietario del portal.
          </p>
        ) : null
      ) : (
        <ul className="org-list">
          {organizations.map((organization) => (
            <li key={organization.tenantId}>
              <Link href={`/o/${organization.slug}`} className="org-card">
                <span>
                  <span className="org-name">{organization.displayName}</span>
                  {organization.tenantStatus === "provisioning" ? (
                    <span className="org-detail">
                      En preparación: el portal aún no está en línea
                    </span>
                  ) : null}
                </span>
                <span className="org-role">{ROLE_LABELS[organization.role]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {operator !== "none" ? (
        <p>
          <Link href="/plataforma" className="button button-quiet">
            Administrar la plataforma
          </Link>
        </p>
      ) : null}
    </main>
  );
}
