import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { currentAdminActor } from "@/server/admin-session";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Iniciar sesión" };

interface LoginPageProps {
  readonly searchParams: Promise<{ error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if ((await currentAdminActor()) !== null) redirect("/");
  const { error } = await searchParams;

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-narrow">
      <p className="eyebrow">Rikuy · panel central</p>
      <h1 className="title title-sm">Iniciar sesión</h1>
      <p className="lead">Te enviaremos un código de acceso a tu correo. No usamos contraseñas.</p>
      <LoginForm
        {...(error === "link"
          ? { initialError: "El enlace no es válido o ya venció. Pide un código nuevo." }
          : {})}
      />
    </main>
  );
}
