import {
  contentImagePath,
  documentImages,
  loadDestinationEditor,
  richTextToMarkup,
  ROLE_LABELS,
  type ImageReference,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";
import { platformSettings, publishedContentReader } from "@/server/platform";

import { SignOutButton } from "../../../../sign-out-button";
import { DestinationEditor, type EditorValues } from "./destination-editor";
import type { EditorImage } from "./image-fields";
import { PortalShare } from "./portal-share";
import { RevisionHistory } from "./revision-history";

export const metadata: Metadata = { title: "Editar destino" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "long",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

/** Where the map opens when the destination has no location yet. */
async function mapCenter(tenantId: string) {
  const points = (
    await publishedContentReader()
      .list(tenantId)
      .catch(() => [])
  )
    .map((entry) => entry.location)
    .filter((point) => point !== null);
  if (points.length === 0) return { lat: 0, lng: 0, zoom: 2 };
  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  return { lat, lng, zoom: 13 };
}

interface EditorPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

export default async function DestinationEditorPage({ params }: EditorPageProps) {
  const { slug, id } = await params;
  const membership = await requireOrganization(slug);
  if (!UUID.test(id)) notFound();
  const session = await adminSession();
  const editor = await loadDestinationEditor(membership, id, session.content);
  if (editor === null) notFound();

  const { record, document } = editor;
  const images = documentImages(document);
  const previewPath = (image: ImageReference) =>
    contentImagePath(membership.tenantId, image, "w480.webp");
  const [previews, center] = await Promise.all([
    session.media.signedPreviewUrls(images.map(previewPath)),
    document.location
      ? Promise.resolve({ ...document.location, zoom: 16 })
      : mapCenter(membership.tenantId),
  ]);
  const withPreview = (image: ImageReference): EditorImage => ({
    ...image,
    previewUrl: previews.get(previewPath(image)) ?? null,
  });
  const initial: EditorValues = {
    title: document.title,
    summary: document.summary,
    markup: richTextToMarkup(document.body),
    location: document.location,
    cover: document.cover ? withPreview(document.cover) : null,
    gallery: document.gallery.map(withPreview),
  };
  const published = record.history.find(
    (entry) => entry.revisionId === record.published?.revisionId,
  );

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/destinos`} className="eyebrow">
          ← Destinos de {membership.displayName}
        </Link>
        <SignOutButton />
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">{document.title}</h1>
        <p className="lead">
          {published
            ? `Versión ${published.revisionNo} publicada el ${DATE.format(new Date(published.sealedAt))}.`
            : "Todavía no está publicado: los visitantes no lo ven."}
          {record.draft
            ? ` Hay un borrador (versión ${record.draft.revisionNo}) con cambios sin publicar.`
            : ""}
        </p>
        <p className="cell-detail">Dirección en el portal: /{record.slug}</p>
      </div>

      {editor.canEdit ? null : (
        <p className="notice" role="status">
          Tu rol ({ROLE_LABELS[membership.role]}) puede ver este destino, pero no cambiarlo.
        </p>
      )}

      <div className="editor-layout">
        <DestinationEditor
          kind="destination"
          org={membership.slug}
          contentId={record.contentId}
          initial={initial}
          editCount={editor.editCount}
          canEdit={editor.canEdit}
          canPublish={editor.canPublish}
          hasPublished={record.published !== null}
          mapCenter={center}
        />
        <aside className="history">
          {editor.portalPath ? (
            <PortalShare
              url={`${platformSettings().portalOrigin(editor.portalPath.hostname)}${editor.portalPath.path}`}
              slug={record.slug}
              title={published?.title ?? document.title}
              portalOnline={membership.tenantStatus === "active"}
            />
          ) : null}
          <section aria-labelledby="historial">
            <h2 id="historial">Historial de publicaciones</h2>
            <p className="field-hint">
              Cada publicación queda guardada. Volver a una versión la muestra otra vez a los
              visitantes sin borrar las demás.
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
