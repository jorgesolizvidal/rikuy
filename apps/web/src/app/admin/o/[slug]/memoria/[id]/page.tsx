import { loadStoryEditor, richTextToMarkup, ROLE_LABELS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireModule } from "@/server/organization";

import { RevisionHistory } from "../../destinos/[id]/revision-history";
import { StoryEditor, type StoryValues } from "./story-editor";

export const metadata: Metadata = { title: "Editar relato" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface EditorPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

export default async function StoryEditorPage({ params }: EditorPageProps) {
  const { slug, id } = await params;
  const membership = await requireModule(slug, "community_memory");
  if (!UUID.test(id)) notFound();
  const editor = await loadStoryEditor(membership, id, (await adminSession()).stories);
  if (editor === null) notFound();

  const { record, document } = editor;
  const initial: StoryValues = {
    title: document.title,
    summary: document.summary,
    markup: richTextToMarkup(document.body),
    author: document.author,
    anonymous: document.anonymous,
    community: document.community,
    placeId: document.placeId ?? "",
    consent: document.consent,
  };

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/memoria`} className="eyebrow">
          ← Memoria de la comunidad
        </Link>
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">{document.title}</h1>
        <p className="lead">
          {record.published
            ? "Publicado: se ve en la página «Memoria» del portal y el asistente lo cuenta."
            : editor.retired
              ? "Retirado: no se ve. Puedes volver a publicar una versión anterior o una nueva."
              : "Todavía no está publicado: no se ve en el portal."}
          {record.draft
            ? ` Hay un borrador (versión ${record.draft.revisionNo}) con cambios sin publicar.`
            : ""}
        </p>
      </div>

      {editor.canEdit ? null : (
        <p className="notice" role="status">
          Tu rol ({ROLE_LABELS[membership.role]}) puede ver este relato, pero no cambiarlo.
        </p>
      )}

      <div className="editor-layout">
        <StoryEditor
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
              Cada publicación queda guardada con el permiso con que se publicó; puedes volver a
              cualquiera de ellas.
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
