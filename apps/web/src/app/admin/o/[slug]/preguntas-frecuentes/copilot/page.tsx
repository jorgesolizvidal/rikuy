import { canPropose, hasModule } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { aiGatewayStatus } from "@/server/ai-gateway";
import { requireOrganization } from "@/server/organization";

import { FaqProposer } from "./faq-proposer";

export const metadata: Metadata = { title: "Crear pregunta frecuente con el Copilot" };

interface ProposerPageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ pregunta?: string | string[] }>;
}

/**
 * «Crear pregunta frecuente con el Copilot» (ADR-074): only for editors and above of a
 * municipality with the Copilot, with the AI configured. Nothing is saved until «Crear el
 * borrador», and then only as a draft.
 */
export default async function FaqProposerPage({ params, searchParams }: ProposerPageProps) {
  const membership = await requireOrganization((await params).slug);
  if (
    !canPropose(membership) ||
    !hasModule(membership.modules, "copilot") ||
    !aiGatewayStatus().configured
  ) {
    notFound();
  }
  const asked = (await searchParams).pregunta;
  const question = typeof asked === "string" ? asked.slice(0, 120) : "";

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/preguntas-frecuentes`} className="eyebrow">
          ← Preguntas frecuentes
        </Link>
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Crear pregunta frecuente con el Copilot</h1>
        <p className="lead">
          El Copilot propone la pregunta y una respuesta con lo que el municipio ya publicó, y te
          dice de dónde la sacó. Si nada publicado la responde, solo propone la pregunta y tú
          escribes la respuesta. Nada se guarda hasta que pulses «Crear el borrador», y nada se
          publica solo.
        </p>
      </div>
      <FaqProposer org={membership.slug} initialQuestion={question} />
    </main>
  );
}
