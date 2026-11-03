import { ASSISTANT_GOLD, GOLD_BATCH } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { aiGatewayStatus } from "@/server/ai-gateway";
import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../sign-out-button";
import { GoldRunner } from "./gold-runner";

export const metadata: Metadata = { title: "Evaluar el asistente" };

/** Five cases with the real model, spaced: about a minute and a half per run. */
export const maxDuration = 300;

export default async function AssistantEvaluationPage() {
  const { gate, session } = await operatorContext();
  if (gate.status === "denied") notFound();
  if (gate.status !== "granted") redirect("/plataforma");
  const demos = (await session.platform.listTenants()).filter(
    (tenant) => tenant.demo && tenant.status === "active" && tenant.canonicalHost !== null,
  );
  const status = aiGatewayStatus();

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href="/plataforma" className="eyebrow">
          ← Plataforma
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Evaluar el asistente</h1>
        <p className="lead">
          Las {ASSISTANT_GOLD.length} preguntas del gold sobre el contenido de muestra, hechas al
          asistente de una demo con el modelo real. Cada una se califica sola: si cita la fuente
          esperada, si se abstiene cuando no hay nada publicado, si responde en el idioma de la
          pregunta y si alguna cita era inventada.
        </p>
        <p className="field-hint">
          Corre {GOLD_BATCH} preguntas por vez, separadas unos segundos para no pasar el límite de
          tokens por minuto de Groq (cada tanda tarda alrededor de un minuto y medio). Todas cuentan
          en la cuota de IA de la demo: para las {ASSISTANT_GOLD.length} conviene subirla a 200 mil
          tokens ese día en <Link href="/plataforma/cuotas">Cuotas</Link>. No se guarda nada: copia
          los resultados al terminar.
        </p>
      </div>
      {!status.configured ? (
        <p className="notice" role="status">
          La IA no está configurada en este despliegue: no hay nada que evaluar.
        </p>
      ) : demos.length === 0 ? (
        <p className="notice" role="status">
          No hay ninguna demo en línea. Da de alta una demo comercial, ponla en línea y carga su
          contenido de muestra (con la guía del asistente) antes de evaluar.
        </p>
      ) : (
        <GoldRunner
          demos={demos.map((tenant) => ({
            tenantId: tenant.tenantId,
            displayName: tenant.displayName,
          }))}
          total={ASSISTANT_GOLD.length}
        />
      )}
    </main>
  );
}
