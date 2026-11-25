import { loadServiceEditor, ROLE_LABELS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireModule } from "@/server/organization";
import { publishedContentReader } from "@/server/platform";

import { toHoursValues } from "../../destinos/[id]/hours-values";
import { RevisionHistory } from "../../destinos/[id]/revision-history";
import { ServiceEditor, type ServiceValues } from "./service-editor";

export const metadata: Metadata = { title: "Editar servicio" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Where the map opens when the service has no place yet: around the municipality's places. */
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
  return { lat, lng, zoom: 14 };
}

interface EditorPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

export default async function ServiceEditorPage({ params }: EditorPageProps) {
  const { slug, id } = await params;
  const membership = await requireModule(slug, "services");
  if (!UUID.test(id)) notFound();
  const editor = await loadServiceEditor(membership, id, (await adminSession()).services);
  if (editor === null) notFound();

  const { record, document } = editor;
  const initial: ServiceValues = {
    title: document.title,
    summary: document.summary,
    category: document.category,
    hours: toHoursValues(document.hours),
    phone: document.phone ?? "",
    whatsapp: document.whatsapp ?? "",
    address: document.address,
    location: document.location,
  };
  const center = document.location
    ? { ...document.location, zoom: 17 }
    : await mapCenter(membership.tenantId);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/servicios`} className="eyebrow">
          ← Servicios locales
        </Link>
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">{document.title}</h1>
        <p className="lead">
          {record.published
            ? "Publicado: se ve en la página «Servicios» del portal y el asistente lo usa."
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
          Tu rol ({ROLE_LABELS[membership.role]}) puede ver este servicio, pero no cambiarlo.
        </p>
      )}

      <div className="editor-layout">
        <ServiceEditor
          org={membership.slug}
          contentId={record.contentId}
          initial={initial}
          mapCenter={center}
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
