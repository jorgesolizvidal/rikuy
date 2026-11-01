import { loadKnowledgeEditor, richTextToMarkup, ROLE_LABELS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../../sign-out-button";
import { RevisionHistory } from "../../destinos/[id]/revision-history";
import { KnowledgeEditor, type KnowledgeValues } from "./knowledge-editor";

export const metadata: Metadata = { title: "Editar conocimiento" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "long",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

interface EditorPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

export default async function KnowledgeEditorPage({ params }: EditorPageProps) {
  const { slug, id } = await params;
  const membership = await requireOrganization(slug);
  if (!UUID.test(id)) notFound();
  const editor = await loadKnowledgeEditor(membership, id, (await adminSession()).knowledge);
  if (editor === null) notFound();

  const { record, document } = editor;
  const initial: KnowledgeValues = {
    title: document.title,
    summary: document.summary,
    markup: richTextToMarkup(document.body),
    document: document.document,
  };
  const published = record.history.find(
    (entry) => entry.revisionId === record.published?.revisionId,
  );

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/conocimiento`} className="eyebrow">
          ← Conocimiento del asistente
        </Link>
        <SignOutButton />
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">{document.title}</h1>
        <p className="lead">
          {published
            ? `Versión ${published.revisionNo} publicada el ${DATE.format(new Date(published.sealedAt))}: el asistente la usa.`
            : editor.retired
              ? "Retirado: el asistente no lo usa. Puedes volver a publicar una versión anterior."
              : "Todavía no está publicado: el asistente no lo usa."}
          {record.draft
            ? ` Hay un borrador (versión ${record.draft.revisionNo}) con cambios sin publicar.`
            : ""}
        </p>
      </div>

      {editor.canEdit ? null : (
        <p className="notice" role="status">
          Tu rol ({ROLE_LABELS[membership.role]}) puede ver este conocimiento, pero no cambiarlo.
        </p>
      )}

      <div className="editor-layout">
        <KnowledgeEditor
          org={membership.slug}
          contentId={record.contentId}
          initial={initial}
          initialDocument={editor.attachment}
          editCount={editor.editCount}
          canEdit={editor.canEdit}
          canPublish={editor.canPublish}
          published={record.published !== null}
        />
        <aside className="history">
          <section aria-labelledby="historial">
            <h2 id="historial">Historial de publicaciones</h2>
            <p className="field-hint">
              Cada publicación queda guardada. Volver a una versión hace que el asistente use esa,
              al momento.
            </p>
            <RevisionHistory
              org={membership.slug}
              contentId={record.contentId}
              entries={record.history}
              publishedRevisionId={record.published?.revisionId ?? null}
              canPublish={editor.canPublish}
            />
          </section>
        </aside>
      </div>
    </main>
  );
}
