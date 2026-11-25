import {
  describeNoticeValidity,
  loadNoticeEditor,
  richTextToMarkup,
  ROLE_LABELS,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { ContentWebLink } from "../../asistente-web/visitor-shares";
import { RevisionHistory } from "../../destinos/[id]/revision-history";
import { NoticeEditor, type NoticeValues } from "./notice-editor";

export const metadata: Metadata = { title: "Editar aviso" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface EditorPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

const PUBLISHED = {
  active: "Vigente: se ve en el portal y el asistente lo dice primero.",
  scheduled: "Programado: empieza a verse en su fecha «desde».",
  expired:
    "Vencido: ya no se ve ni lo usa el asistente. Para volver a avisarlo, publica una versión con otra fecha.",
  incomplete: "Publicado sin fecha de fin.",
} as const;

export default async function NoticeEditorPage({ params }: EditorPageProps) {
  const { slug, id } = await params;
  const membership = await requireOrganization(slug);
  if (!UUID.test(id)) notFound();
  const editor = await loadNoticeEditor(membership, id, new Date(), (await adminSession()).notices);
  if (editor === null) notFound();

  const { record, document } = editor;
  const initial: NoticeValues = {
    title: document.title,
    summary: document.summary,
    markup: richTextToMarkup(document.body),
    from: document.validity.from ?? "",
    until: document.validity.until ?? "",
    placeId: document.placeId ?? "",
  };
  const live = record.published?.document.validity;

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/avisos`} className="eyebrow">
          ← Avisos
        </Link>
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">{document.title}</h1>
        <p className="lead">
          {editor.publishedState && live
            ? `${PUBLISHED[editor.publishedState]} ${describeNoticeValidity(live) ?? ""}.`
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
          Tu rol ({ROLE_LABELS[membership.role]}) puede ver este aviso, pero no cambiarlo.
        </p>
      )}

      <div className="editor-layout">
        <NoticeEditor
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
          <ContentWebLink membership={membership} contentId={record.contentId} />
          <section aria-labelledby="historial">
            <h2 id="historial">Historial de publicaciones</h2>
            <p className="field-hint">
              Cada publicación queda guardada. Volver a una versión la publica con su fecha: si ya
              venció, no se verá.
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
