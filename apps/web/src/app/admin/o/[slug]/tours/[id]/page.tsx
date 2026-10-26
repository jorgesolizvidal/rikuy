import { loadTourEditor, richTextToMarkup } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../../sign-out-button";
import { KIND, TOUR_STATUS } from "../labels";
import { TourEditor } from "./tour-editor";

export const metadata: Metadata = { title: "Tour 360°" };

const DAY = new Intl.DateTimeFormat("es-BO", { dateStyle: "medium", timeZone: "America/La_Paz" });

interface TourPageProps {
  readonly params: Promise<{ slug: string; id: string }>;
}

function size(width: number | null, height: number | null): string | null {
  return width && height ? `${width} × ${height} px` : null;
}

export default async function TourPage({ params }: TourPageProps) {
  const { slug, id } = await params;
  const membership = await requireOrganization(slug);
  const session = await adminSession();
  const editor = await loadTourEditor(membership, id, {
    tours: session.tours,
    panoramas: session.panoramas,
    models: session.models,
    media: session.media,
  });
  if (editor === null) notFound();

  const { record, revision } = editor;
  const status =
    record.published === null ? "draft" : record.draft === null ? "published" : "changed";
  const kind = KIND[record.content.kind];

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}/tours`} className="eyebrow">
          ← Tours 360°
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Tour de {record.content.title}</h1>
        <p className="tour-meta">
          <span className="status-pill" data-status={status}>
            {TOUR_STATUS[status].label}
          </span>
          <span>
            {TOUR_STATUS[status].detail}
            {record.published ? ` · versión ${record.published.revisionNo} publicada` : ""}
          </span>
          <Link href={`/o/${membership.slug}/${kind.path}/${record.content.contentId}`}>
            Ver el {kind.label.toLowerCase()}
          </Link>
        </p>
        {record.content.published ? null : (
          <p className="field-hint">
            El {kind.label.toLowerCase()} todavía no está publicado: los visitantes verán el tour
            cuando ambos lo estén.
          </p>
        )}
      </div>
      {!editor.canEdit ? (
        <p className="notice" role="status">
          Tu rol puede ver este tour, pero no cambiarlo.
        </p>
      ) : null}

      <TourEditor
        org={membership.slug}
        tourId={record.tourId}
        contentTitle={record.content.title}
        editCount={editor.editCount}
        entrySceneId={revision.entrySceneId}
        scenes={editor.scenes.map((scene) => ({
          sceneId: scene.sceneId,
          title: scene.title,
          description: scene.description,
          initialView: scene.initialView,
          previewUrl: scene.previewUrl,
          imageUrl: scene.imageUrl,
          size: size(scene.panorama.width, scene.panorama.height),
          hotspots: scene.hotspots.map((hotspot) => ({
            hotspotId: hotspot.hotspotId,
            kind: hotspot.kind,
            title: hotspot.title,
            position: hotspot.position,
            body: richTextToMarkup(hotspot.body),
            gallery: hotspot.gallery.map((image) => ({ ...image })),
            targetSceneId: hotspot.targetSceneId,
            model: hotspot.model
              ? { versionId: hotspot.model.versionId, posterUrl: hotspot.posterUrl }
              : null,
            target: hotspot.target
              ? {
                  contentId: hotspot.target.contentId,
                  kind: hotspot.target.kind,
                  title: hotspot.target.title,
                  tourPublished: hotspot.target.tourPublished,
                }
              : null,
          })),
        }))}
        options={editor.options.map((option) => ({
          versionId: option.versionId,
          previewUrl: option.previewUrl,
          size: size(option.width, option.height),
          uploaded: DAY.format(new Date(option.createdAt)),
        }))}
        models={editor.models.map((model) => ({
          versionId: model.versionId,
          posterUrl: model.posterUrl,
          hasPoster: model.hasPoster,
          label: `Modelo subido el ${DAY.format(new Date(model.createdAt))}${
            model.triangles ? ` · ${model.triangles.toLocaleString("es-BO")} triángulos` : ""
          }`,
        }))}
        targets={editor.targets}
        canEdit={editor.canEdit}
        canPublish={editor.canPublish}
        hasDraft={record.draft !== null}
        hasPublished={record.published !== null}
        issues={record.draft ? editor.publicationIssues : []}
        history={record.history.map((entry) => ({
          ...entry,
          current: entry.revisionId === record.published?.revisionId,
        }))}
      />
    </main>
  );
}
