import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getPortalTenantContext } from "@/server/tenant-context";

interface PortalPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: PortalPageProps): Promise<Metadata> {
  const context = await getPortalTenantContext((await params).host);
  if (context === null) return {};
  return {
    title: context.tenant.displayName,
    description: `Portal turístico de ${context.tenant.displayName}.`,
  };
}

export default async function PortalHomePage({ params }: PortalPageProps) {
  const context = await getPortalTenantContext((await params).host);
  if (context === null) notFound();

  const { tenant } = context;

  return (
    <main className="shell" lang={tenant.defaultLocale}>
      <p className="eyebrow">Portal turístico</p>
      <h1 className="title">{tenant.displayName}</h1>
      <p className="lead">
        Este portal pronto mostrará los destinos, eventos, tours 360° y la guía de{" "}
        {tenant.displayName}.
      </p>
      <p className="status" role="status">
        <span className="dot" aria-hidden="true" />
        En construcción
      </p>
    </main>
  );
}
