import { assignableRoles, canAssignRole, listMembers, ROLE_LABELS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { invitationMailConfigured } from "@/server/mail-settings";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import { InviteMemberForm, MemberRowActions } from "./member-forms";

export const metadata: Metadata = { title: "Miembros" };

const STATUS_LABELS = {
  active: "Activo",
  invited: "Invitación pendiente",
  revoked: "Acceso revocado",
} as const;

interface MembersPageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function MembersPage({ params }: MembersPageProps) {
  const membership = await requireOrganization((await params).slug);
  const members = await listMembers(membership, (await adminSession()).members);
  // Editors and analysts have no roster view: same answer as an unknown page.
  if (members === null) notFound();

  const roles = assignableRoles(membership.role);
  const mail = invitationMailConfigured();

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Miembros</h1>
        <p className="lead">
          Quién puede entrar al panel de {membership.displayName} y qué puede hacer.
          {membership.role === "admin" ? " Como administrador gestionas editores y analistas." : ""}
        </p>
      </div>

      <section aria-labelledby="invitar" className="members-invite">
        <h2 id="invitar">Invitar a una persona</h2>
        <InviteMemberForm
          slug={membership.slug}
          mail={mail}
          roles={roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
        />
      </section>

      {/* Focusable so the table can be scrolled sideways with the keyboard on a phone. */}
      <div className="table-wrap" role="region" aria-label="Lista de miembros" tabIndex={0}>
        <table className="data-table">
          <caption className="visually-hidden">Miembros de {membership.displayName}</caption>
          <thead>
            <tr>
              <th scope="col">Correo</th>
              <th scope="col">Rol</th>
              <th scope="col">Estado</th>
              <th scope="col">
                <span className="visually-hidden">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const manageable =
                member.status !== "revoked" && canAssignRole(membership.role, member.role, null);
              return (
                <tr key={member.membershipId} data-status={member.status}>
                  <td>{member.email}</td>
                  <td>{ROLE_LABELS[member.role]}</td>
                  <td>
                    {STATUS_LABELS[member.status]}
                    {member.status === "invited" ? (
                      <span className="org-detail">
                        {member.invitationMailedAt
                          ? "Se le envió un correo"
                          : mail
                            ? "Correo en camino"
                            : "Sin correo: avísale tú"}
                      </span>
                    ) : null}
                  </td>
                  <td className="cell-actions">
                    {manageable ? (
                      <MemberRowActions
                        slug={membership.slug}
                        membershipId={member.membershipId}
                        email={member.email}
                        currentRole={member.role}
                        roles={roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
