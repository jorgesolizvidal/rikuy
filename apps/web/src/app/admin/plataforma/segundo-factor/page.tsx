import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../sign-out-button";
import { ResetSecondFactorForm } from "./reset-form";

export const metadata: Metadata = { title: "Restablecer la verificación en dos pasos" };

export default async function ResetSecondFactorPage() {
  const { gate } = await operatorContext();
  if (gate.status === "denied") notFound();
  if (gate.status !== "granted") redirect("/plataforma");

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-narrow">
      <header className="admin-header">
        <Link href="/plataforma" className="eyebrow">
          ← Plataforma
        </Link>
        <SignOutButton />
      </header>
      <h1 className="title title-sm">Restablecer la verificación en dos pasos</h1>
      <p className="lead">
        Para un propietario o administrador que perdió el teléfono con su app de autenticación.
      </p>
      <ul>
        <li>
          Se borra su app configurada; la próxima vez que abra su municipio, configura una nueva.
        </li>
        <li>Queda registrado en la auditoría de cada uno de sus municipios, con tu cuenta.</li>
        <li>
          Las sesiones que ya tiene abiertas siguen abiertas. Si alguien más pudo entrar a su
          cuenta, pide al propietario que le quite el acceso en «Miembros».
        </li>
      </ul>
      <p>
        Antes de hacerlo, confirma que la persona es quien dice ser (por ejemplo, por teléfono).
      </p>
      <ResetSecondFactorForm />
    </main>
  );
}
