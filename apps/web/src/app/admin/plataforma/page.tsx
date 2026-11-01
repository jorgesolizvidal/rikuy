import { listPlatformTenants, loadOperations, type TenantStatus } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { aiGatewayStatus } from "@/server/ai-gateway";
import { operatorContext } from "@/server/operator";
import { platformSettings } from "@/server/platform";

import { SignOutButton } from "../sign-out-button";
import { AiSummary } from "./ai-summary";
import { MfaPanel } from "./mfa-panel";
import { OperationsSummary } from "./operations-summary";
import { TenantStatusButton } from "./tenant-status-button";

export const metadata: Metadata = { title: "Plataforma" };

const STATUS_LABELS: Readonly<Record<TenantStatus, string>> = {
  provisioning: "En preparación",
  active: "En línea",
  suspended: "Suspendido",
};

export default async function PlatformPage() {
  const { actor, gate, session } = await operatorContext();
  // The platform area does not exist for anyone who is not an operator.
  if (gate.status === "denied") notFound();

  const header = (
    <header className="admin-header">
      <Link href="/" className="eyebrow">
        ← Tus municipios
      </Link>
      <SignOutButton />
    </header>
  );

  if (gate.status !== "granted") {
    return (
      <main id="contenido" tabIndex={-1} className="shell shell-narrow">
        {header}
        <h1 className="title title-sm">Verificación en dos pasos</h1>
        <p className="lead">
          {gate.status === "enroll"
            ? "La administración de la plataforma exige un segundo factor. Configura una app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…) para continuar."
            : "Escribe el código de 6 dígitos de tu app de autenticación para continuar."}
        </p>
        <MfaPanel mode={gate.status} factorId={gate.status === "verify" ? gate.factorId : null} />
      </main>
    );
  }

  const [tenants, operations] = await Promise.all([
    listPlatformTenants(session.platform).then((list) => list ?? []),
    loadOperations(session.platform, session.operations),
  ]);
  const { portalOrigin } = platformSettings();

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      {header}
      <div className="branding-heading">
        <h1 className="title title-sm">Plataforma</h1>
        <p className="lead">
          {tenants.length === 1 ? "1 municipio" : `${tenants.length} municipios`}. Sesión de
          operador: {actor.email}.
        </p>
        <p>
          <Link href="/plataforma/nuevo" className="button">
            Dar de alta un municipio
          </Link>{" "}
          <Link href="/plataforma/trabajos" className="button button-quiet">
            Trabajos en segundo plano
          </Link>{" "}
          <Link href="/plataforma/cuotas" className="button button-quiet">
            Cuotas por municipio
          </Link>
        </p>
      </div>

      {operations ? (
        <OperationsSummary snapshot={operations.snapshot} alerts={operations.alerts} />
      ) : null}

      <AiSummary
        ai={operations?.snapshot.ai}
        status={aiGatewayStatus()}
        tenants={tenants
          .filter((tenant) => tenant.status !== "suspended")
          .map(({ tenantId, displayName }) => ({ tenantId, displayName }))}
      />

      <h2 className="operations-heading">Municipios</h2>
      <div className="table-wrap">
        <table className="data-table">
          <caption className="visually-hidden">Municipios de la plataforma</caption>
          <thead>
            <tr>
              <th scope="col">Municipio</th>
              <th scope="col">Estado</th>
              <th scope="col">Propietario</th>
              <th scope="col">
                <span className="visually-hidden">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.tenantId}>
                <td>
                  <span className="org-name">{tenant.displayName}</span>
                  {tenant.canonicalHost ? (
                    <a
                      className="org-detail"
                      href={portalOrigin(tenant.canonicalHost)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {tenant.canonicalHost}
                      <span className="visually-hidden"> (se abre en otra pestaña)</span>
                    </a>
                  ) : null}
                </td>
                <td>
                  <span className="status-pill" data-status={tenant.status}>
                    {STATUS_LABELS[tenant.status]}
                  </span>
                  {tenant.demo ? <span className="org-detail">Demo comercial</span> : null}
                </td>
                <td>
                  {tenant.ownerEmail ?? "Sin propietario"}
                  {tenant.ownerStatus === "invited" ? (
                    <span className="org-detail">Invitación sin aceptar</span>
                  ) : null}
                </td>
                <td className="cell-actions">
                  {tenant.status === "active" ? (
                    <TenantStatusButton
                      tenantId={tenant.tenantId}
                      target="suspended"
                      label="Suspender"
                    />
                  ) : (
                    <TenantStatusButton
                      tenantId={tenant.tenantId}
                      target="active"
                      label={tenant.status === "suspended" ? "Reactivar" : "Poner en línea"}
                      disabledReason={
                        tenant.ownerStatus === "active"
                          ? null
                          : "Se puede poner en línea cuando el propietario acepte la invitación."
                      }
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
