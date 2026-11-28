import { loadFaqEditor, richTextToMarkup, ROLE_LABELS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { RevisionHistory } from "../../destinos/[id]/revision-history";
import { FaqEditor, type FaqValues } from "./faq-editor";

export const metadata: Metadata = { title: "Editar pregunta frecuente" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface EditorPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

export default async function FaqEditorPage({ params }: EditorPageProps) {
  const { slug, id } = await params;
  const membership = await requireOrganization(slug);
  if (!UUID.test(id)) notFound();
  const editor = await loadFaqEditor(membership, id, (await adminSession()).faqs);
  if (editor === null) notFound();

  const { record, document } = editor;
  const initial: FaqValues = {
    title: document.title,
    summary: document.summary,
    markup: richTextToMarkup(document.body),
    topic: document.topic,
    placeId: document.placeId ?? "",
  };

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/preguntas-frecuentes`} className="eyebrow">
          ← Preguntas frecuentes
        </Link>
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">{document.title}</h1>
        <p className="lead">
          {record.published
            ? "Publicada: se ve en la página «Preguntas frecuentes» del portal y el asistente responde con ella."
            : editor.retired
              ? "Retirada: no se ve. Puedes volver a publicar una versión anterior o una nueva."
              : "Todavía no está publicada: no se ve en el portal."}
          {record.draft
            ? ` Hay un borrador (versión ${record.draft.revisionNo}) con cambios sin publicar.`
            : ""}
        </p>
      </div>

      {editor.canEdit ? null : (
        <p className="notice" role="status">
          Tu rol ({ROLE_LABELS[membership.role]}) puede ver esta pregunta, pero no cambiarla.
        </p>
      )}

      <div className="editor-layout">
        <FaqEditor
          org={membership.slug}
          contentId={record.contentId}
          initial={initial}
          places={editor.places}
          editCount={editor.editCount}
          canEdit={editor.canEdit}
          canPublish={editor.canPublish}
          published={record.published !== null}
        />
        <aside className="history">
          <section aria-labelledby="historial">
            <h2 id="historial">Historial de publicaciones</h2>
            <p className="field-hint">
              Cada publicación queda guardada; puedes volver a cualquiera de ellas.
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
