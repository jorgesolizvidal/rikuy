import {
  COPILOT_PATHS,
  loadProposal,
  PROPOSAL_FIELD_LABELS,
  richTextToMarkup,
  wordDiff,
  type ProposalField,
  type ProposalValue,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireModule } from "@/server/organization";

import { SignOutButton } from "../../../../../sign-out-button";
import { ProposalReview, type FieldDiff } from "./proposal-review";

export const metadata: Metadata = { title: "Propuesta del Copilot" };

const ORDER: readonly ProposalField[] = ["title", "summary", "description", "body"];

function asText(value: ProposalValue): string {
  return typeof value === "string" ? value : richTextToMarkup(value);
}

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "long",
  timeZone: "America/La_Paz",
});

interface ProposalPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

export default async function ProposalPage({ params }: ProposalPageProps) {
  const { slug, id } = await params;
  const membership = await requireModule(slug, "copilot");
  const session = await adminSession();
  const proposal = await loadProposal(membership, id, session.copilot);
  if (!proposal) notFound();

  const org = membership.slug;
  const fields: FieldDiff[] = ORDER.flatMap((field) => {
    const change = proposal.changes[field];
    if (!change) return [];
    const before = asText(change.from);
    const after = asText(change.to);
    return [
      {
        field,
        label: PROPOSAL_FIELD_LABELS[field],
        multiline: field === "body",
        parts: wordDiff(before, after),
        after,
      },
    ];
  });
  const editor =
    proposal.target.type === "scene"
      ? COPILOT_PATHS.tour(org, proposal.target.tourId)
      : COPILOT_PATHS.editor(org, proposal.contentKind, proposal.contentId);
  const name = proposal.sceneTitle
    ? `Escena «${proposal.sceneTitle}» del tour 360° de «${proposal.title}»`
    : `${proposal.contentKind === "event" ? "Evento" : "Destino"} «${proposal.title}»`;

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <header className="admin-header">
        <Link href={COPILOT_PATHS.home(org)} className="eyebrow">
          ← Copilot
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Propuesta del Copilot</h1>
        <p className="lead">{name}</p>
        <p className="field-hint">
          Pedida el {DATE.format(new Date(proposal.createdAt))}
          {proposal.instruction ? ` · «${proposal.instruction}»` : ""}. Revisa cada cambio: lo
          tachado se quita y lo subrayado se agrega. Marca lo que quieras guardar; se guarda como
          borrador y lo publicas tú desde el editor.
        </p>
        {proposal.sources.length > 0 ? (
          <p className="copilot-sources">
            Escrita con:{" "}
            {proposal.sources.map((source) => `${source.label} «${source.title}»`).join(" · ")}
          </p>
        ) : (
          <p className="copilot-sources">Escrita solo con el contenido actual.</p>
        )}
      </div>

      <ProposalReview
        org={org}
        proposalId={proposal.id}
        status={proposal.status}
        stale={proposal.stale}
        acceptedFields={proposal.acceptedFields}
        fields={fields}
        editorHref={editor}
        againHref={COPILOT_PATHS.propose(org, proposal.target)}
      />
    </main>
  );
}
