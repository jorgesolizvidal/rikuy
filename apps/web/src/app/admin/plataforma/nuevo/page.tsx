import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { operatorContext } from "@/server/operator";
import { platformSettings } from "@/server/platform";

import { SignOutButton } from "../../sign-out-button";
import { ProvisionForm } from "./provision-form";

export const metadata: Metadata = { title: "Dar de alta un municipio" };

export default async function NewTenantPage() {
  const { gate } = await operatorContext();
  if (gate.status === "denied") notFound();
  // Second factor pending: the gate lives on the platform home (page redirect, not an action).
  if (gate.status !== "granted") redirect("/plataforma");

  const { hosts, adminOrigin } = platformSettings();

  return (
    <main className="shell shell-narrow">
      <header className="admin-header">
        <Link href="/plataforma" className="eyebrow">
          ← Plataforma
        </Link>
        <SignOutButton />
      </header>
      <h1 className="title title-sm">Dar de alta un municipio</h1>
      <p className="lead">
        Se crea en preparación con su dirección y una invitación para su propietario. Lo pones en
        línea cuando el propietario acepte.
      </p>
      <ProvisionForm rootDomain={hosts.rootDomain} adminOrigin={adminOrigin} />
    </main>
  );
}
