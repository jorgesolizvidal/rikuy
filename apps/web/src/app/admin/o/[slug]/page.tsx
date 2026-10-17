import { openOrganization, ROLE_LABELS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession, requireAdminActor } from "@/server/admin-session";

import { SignOutButton } from "../../sign-out-button";

interface OrganizationPageProps {
  readonly params: Promise<{ slug: string }>;
}

async function load(slug: string) {
  const actor = await requireAdminActor();
  // Membership is checked live on every request; no membership → 404 (existence is not revealed).
  const membership = await openOrganization(actor, slug, (await adminSession()).memberships);
  if (membership === null) notFound();
  return membership;
}

export async function generateMetadata({ params }: OrganizationPageProps): Promise<Metadata> {
  return { title: (await load((await params).slug)).displayName };
}

export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const membership = await load((await params).slug);

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
      <p className="notice" role="status">
        Aquí llegarán la marca del portal, destinos, eventos, tours 360° y medios.
      </p>
    </main>
  );
}
