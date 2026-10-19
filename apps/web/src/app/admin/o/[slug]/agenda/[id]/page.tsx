import {
  contentImagePath,
  eventImages,
  listDestinations,
  loadEventEditor,
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
import { DestinationEditor, type EditorValues } from "../../destinos/[id]/destination-editor";
import type { EditorImage } from "../../destinos/[id]/image-fields";
import { PortalShare } from "../../destinos/[id]/portal-share";
import { RevisionHistory } from "../../destinos/[id]/revision-history";
import type { VenueOption } from "../../destinos/[id]/schedule-field";
import { scheduleValues } from "../../destinos/[id]/schedule-values";

export const metadata: Metadata = { title: "Editar evento" };

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

export default async function EventEditorPage({ params }: EditorPageProps) {
  const { slug, id } = await params;
  const membership = await requireOrganization(slug);
  if (!UUID.test(id)) notFound();
  const session = await adminSession();
  const editor = await loadEventEditor(membership, id, session.content);
  if (editor === null) notFound();

  const { record, document } = editor;
  const previewPath = (image: ImageReference) =>
    contentImagePath(membership.tenantId, image, "w480.webp");
  const [previews, destinations, published] = await Promise.all([
    session.media.signedPreviewUrls(eventImages(document).map(previewPath)),
    listDestinations(membership, session.content),
    publishedContentReader()
      .list(membership.tenantId)
      .catch(() => []),
  ]);
  const locations = new Map(published.map((entry) => [entry.slug, entry.location]));
  const venues: VenueOption[] = destinations.map((destination) => ({
    contentId: destination.contentId,
    title: destination.title,
    published: destination.status !== "draft",
    location: locations.get(destination.slug) ?? null,
  }));
  const points = [...locations.values()].filter((point) => point !== null);
  const center = document.location
    ? { ...document.location, zoom: 16 }
    : points.length > 0
      ? {
          lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
          lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
          zoom: 13,
        }
      : { lat: 0, lng: 0, zoom: 2 };

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
    schedule: scheduleValues(document.schedule),
    venueId: document.venueId,
  };
  const live = record.history.find((entry) => entry.revisionId === record.published?.revisionId);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/agenda`} className="eyebrow">
          ← Agenda de {membership.displayName}
        </Link>
        <SignOutButton />
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">{document.title}</h1>
        <p className="lead">
          {live
            ? `Versión ${live.revisionNo} publicada el ${DATE.format(new Date(live.sealedAt))}.`
            : "Todavía no está publicado: los visitantes no lo ven."}
          {record.draft
            ? ` Hay un borrador (versión ${record.draft.revisionNo}) con cambios sin publicar.`
            : ""}
        </p>
        <p className="cell-detail">Dirección en el portal: /agenda/{record.slug}</p>
      </div>

      {editor.canEdit ? null : (
        <p className="notice" role="status">
          Tu rol ({ROLE_LABELS[membership.role]}) puede ver este evento, pero no cambiarlo.
        </p>
      )}

      <div className="editor-layout">
        <DestinationEditor
          kind="event"
          org={membership.slug}
          contentId={record.contentId}
          initial={initial}
          editCount={editor.editCount}
          canEdit={editor.canEdit}
          canPublish={editor.canPublish}
          hasPublished={record.published !== null}
          mapCenter={center}
          venues={venues}
          timezoneNote="Escribe la fecha y la hora del municipio."
        />
        <aside className="history">
          {editor.portalPath ? (
            <PortalShare
              url={`${platformSettings().portalOrigin(editor.portalPath.hostname)}${editor.portalPath.path}`}
              slug={record.slug}
              title={live?.title ?? document.title}
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
