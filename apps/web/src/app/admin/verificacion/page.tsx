import { listMyOrganizations, safePanelPath, secondFactorGate } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { adminSession, requireAdminActor } from "@/server/admin-session";

import { MfaPanel } from "../mfa-panel";
import { SignOutButton } from "../sign-out-button";
import { startStaffEnrollmentAction, verifyStaffAction } from "./actions";

export const metadata: Metadata = { title: "Verificación en dos pasos" };

/**
 * Owners and admins act on their municipality only with a second factor (ADR-043). A
 * municipality that needs it sends the person here (`?siguiente=/o/{slug}`); once verified,
 * the session has it for every municipality and the page goes back.
 */
export default async function SecondFactorPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly siguiente?: string | string[] }>;
}) {
  const actor = await requireAdminActor();
  const session = await adminSession();
  const next = safePanelPath((await searchParams).siguiente);
  const gate = await secondFactorGate(actor, session.memberships, session.mfa);
  if (gate.status === "not_needed") redirect(next);

  const waiting = (await listMyOrganizations(actor, session.memberships)).filter(
    (organization) => organization.needsSecondFactor,
  );
  const names = new Intl.ListFormat("es", { type: "conjunction" }).format(
    waiting.map((organization) => organization.displayName),
  );

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-narrow">
      <header className="admin-header">
        <Link href="/" className="eyebrow">
          ← Tus municipios
        </Link>
        <SignOutButton />
      </header>
      <h1 className="title title-sm">Verificación en dos pasos</h1>
      <p className="lead">
        Para administrar {names} necesitas un segundo factor, además del código que llega a tu
        correo.
      </p>
      {gate.status === "enroll" ? (
        <p>
          Configura una app de autenticación en tu teléfono (Google Authenticator, Microsoft
          Authenticator, 1Password…). Lo haces una sola vez; después, al iniciar sesión, solo
          escribes el código que muestra la app.
        </p>
      ) : (
        <p>Escribe el código de 6 dígitos que muestra tu app de autenticación.</p>
      )}
      <MfaPanel
        mode={gate.status}
        factorId={gate.status === "verify" ? gate.factorId : null}
        startEnrollment={startStaffEnrollmentAction}
        verifyCode={verifyStaffAction}
        next={next}
      />
      <p className="field-hint">
        ¿Perdiste el teléfono con la app? Pide al equipo de Rikuy que restablezca tu verificación en
        dos pasos; la configurarás de nuevo al entrar.
      </p>
    </main>
  );
}
