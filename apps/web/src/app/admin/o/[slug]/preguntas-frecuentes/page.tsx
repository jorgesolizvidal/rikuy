import { canEditContent, canPropose, FAQ_TOPIC_NAMES, hasModule, listFaqs } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { NewItem, wantsNew } from "@/components/panel/new-item";
import { adminSession } from "@/server/admin-session";
import { aiGatewayStatus } from "@/server/ai-gateway";
import { requireOrganization } from "@/server/organization";

import { NewFaqForm } from "./faq-forms";

export const metadata: Metadata = { title: "Preguntas frecuentes" };

const STATUS = {
  published: { label: "Publicada", detail: "Se ve en el portal y el asistente la usa" },
  changed: { label: "Con cambios", detail: "Publicada, con cambios sin publicar" },
  draft: { label: "Borrador", detail: "Nunca publicada" },
  retired: { label: "Retirada", detail: "Ya no se ve" },
} as const;

interface FaqsPageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ nuevo?: string | string[]; pregunta?: string | string[] }>;
}

export default async function FaqsPage({ params, searchParams }: FaqsPageProps) {
  const membership = await requireOrganization((await params).slug);
  const faqs = await listFaqs(membership, (await adminSession()).faqs);
  const canEdit = canEditContent(membership.role);
  const search = await searchParams;
  const question = typeof search.pregunta === "string" ? search.pregunta.slice(0, 120) : "";
  const withCopilot =
    canPropose(membership) &&
    hasModule(membership.modules, "copilot") &&
    aiGatewayStatus().configured;

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <div className="branding-heading">
        <h1 className="title title-sm">Preguntas frecuentes</h1>
        <p className="lead">
          Lo que más preguntan los visitantes de {membership.displayName}, con su respuesta. Se ven
          en la página «Preguntas frecuentes» del portal y en la ficha de su lugar, los buscadores
          las muestran y el asistente responde con ellas.
        </p>
      </div>

      {canEdit ? (
        <NewItem
          label="Nueva pregunta"
          open={faqs.length === 0 || question !== "" || wantsNew(search)}
        >
          <NewFaqForm org={membership.slug} initialQuestion={question} />
          {withCopilot ? (
            <p className="field-hint">
              O pídele al Copilot que la proponga con lo publicado:{" "}
              <Link
                href={`/o/${membership.slug}/preguntas-frecuentes/copilot${question ? `?pregunta=${encodeURIComponent(question)}` : ""}`}
              >
                Crear pregunta frecuente con el Copilot
              </Link>
              .
            </p>
          ) : null}
        </NewItem>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver las preguntas, pero no crearlas ni cambiarlas.
        </p>
      )}

      {faqs.length === 0 ? (
        <p className="notice">
          Todavía no hay preguntas. En «Lo que preguntan los visitantes» verás qué preguntan y el
          Copilot te ayuda a escribir la respuesta con lo publicado.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table-cards">
            <caption className="visually-hidden">
              Preguntas frecuentes de {membership.displayName}
            </caption>
            <thead>
              <tr>
                <th scope="col">Pregunta</th>
                <th scope="col">Tema</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {faqs.map((faq) => (
                <tr key={faq.contentId}>
                  <td>
                    <Link href={`/o/${membership.slug}/preguntas-frecuentes/${faq.contentId}`}>
                      {faq.question}
                    </Link>
                  </td>
                  <td data-label="Tema">{FAQ_TOPIC_NAMES[faq.topic]}</td>
                  <td data-label="Estado">
                    <span
                      className="status-pill"
                      data-status={faq.status === "retired" ? "draft" : faq.status}
                    >
                      {STATUS[faq.status].label}
                    </span>
                    <span className="cell-detail">{STATUS[faq.status].detail}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
