import {
  canPropose,
  COPILOT_PATHS,
  loadProposalBase,
  proposalFieldsFor,
  proposalTargetFromQuery,
  richTextToPlainText,
  type ProposalField,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { aiGatewayStatus } from "@/server/ai-gateway";
import { requireModule } from "@/server/organization";

import { SignOutButton } from "../../../../sign-out-button";
import { ProposeForm } from "./propose-form";

export const metadata: Metadata = { title: "Proponer con el Copilot" };

interface ProposePageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProposePage({ params, searchParams }: ProposePageProps) {
  const membership = await requireModule((await params).slug, "copilot");
  const query = await searchParams;
  const target = proposalTargetFromQuery(query);
  if (!target || !canPropose(membership)) notFound();
  const session = await adminSession();
  const base = await loadProposalBase(membership, target, {
    content: session.content,
    tours: session.tours,
  });
  if (!base) notFound();

  const allowed = proposalFieldsFor(target);
  const asked = typeof query.campos === "string" ? query.campos.split(",") : [];
  const preset = allowed.filter((field) => asked.includes(field));
  const initial: ProposalField[] =
    preset.length > 0 ? preset : target.type === "content" ? ["summary", "body"] : ["description"];
  const org = membership.slug;
  const back =
    target.type === "content"
      ? COPILOT_PATHS.editor(org, base.kind, target.contentId)
      : COPILOT_PATHS.tour(org, target.tourId);
  const body = Array.isArray(base.current.body) ? richTextToPlainText(base.current.body) : "";

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <header className="admin-header">
        <Link href={COPILOT_PATHS.home(org)} className="eyebrow">
          ← Copilot
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Proponer con el Copilot</h1>
        <p className="lead">{base.name}</p>
        <p className="field-hint">
          El Copilot escribe una propuesta con lo que ya está escrito y lo publicado del municipio,
          sin inventar datos. Después la revisas campo por campo; lo que aceptes se guarda como
          borrador, nunca se publica solo. Parte de lo último guardado: si tienes cambios sin
          guardar en el editor, guárdalos antes.
        </p>
      </div>

      <section aria-labelledby="actual" className="knowledge-section">
        <h2 id="actual">Lo que dice ahora</h2>
        <dl className="copilot-current">
          <dt>Nombre</dt>
          <dd>{base.title}</dd>
          {"summary" in base.current ? (
            <>
              <dt>Resumen</dt>
              <dd>{(base.current.summary as string) || "(vacío)"}</dd>
            </>
          ) : null}
          {"body" in base.current ? (
            <>
              <dt>Texto</dt>
              <dd className="copilot-current-body">{body || "(vacío)"}</dd>
            </>
          ) : null}
          {"description" in base.current ? (
            <>
              <dt>Descripción de la escena</dt>
              <dd>{(base.current.description as string) || "(vacía)"}</dd>
            </>
          ) : null}
        </dl>
        <p>
          <Link href={back}>Abrir en el editor</Link>
        </p>
      </section>

      <section aria-labelledby="pedido" className="members-invite">
        <h2 id="pedido">Qué pedir</h2>
        {aiGatewayStatus().configured ? (
          <ProposeForm org={org} target={target} fields={allowed} initial={initial} />
        ) : (
          <p className="notice" role="status">
            El Copilot no está disponible en esta plataforma por ahora.
          </p>
        )}
      </section>
    </main>
  );
}
