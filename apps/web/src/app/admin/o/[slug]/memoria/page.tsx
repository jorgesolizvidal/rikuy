import { canEditContent, listStories } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { NewItem, wantsNew } from "@/components/panel/new-item";
import { adminSession } from "@/server/admin-session";
import { requireModule } from "@/server/organization";

import { NewStoryForm } from "./story-forms";

export const metadata: Metadata = { title: "Memoria de la comunidad" };

const STATUS = {
  published: { label: "Publicado", detail: "Se ve en el portal y el asistente lo cuenta" },
  changed: { label: "Con cambios", detail: "Publicado, con cambios sin publicar" },
  draft: { label: "Borrador", detail: "Nunca publicado" },
  retired: { label: "Retirado", detail: "Ya no se ve (la persona pidió retirarlo)" },
} as const;

interface MemoryPageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ nuevo?: string | string[] }>;
}

export default async function MemoryPage({ params, searchParams }: MemoryPageProps) {
  const membership = await requireModule((await params).slug, "community_memory");
  const stories = await listStories(membership, (await adminSession()).stories);
  const canEdit = canEditContent(membership.role);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <div className="branding-heading">
        <h1 className="title title-sm">Memoria de la comunidad</h1>
        <p className="lead">
          Lo que cuentan los vecinos de {membership.displayName}: historias, costumbres y recuerdos.
          Los carga el equipo del municipio, con el nombre de quien lo cuenta y su permiso para
          publicarlo. Se ven en la página «Memoria» del portal y en la ficha de su lugar, y el
          asistente los cuenta siempre como un relato de esa persona.
        </p>
      </div>

      {canEdit ? (
        <NewItem label="Nuevo relato" open={stories.length === 0 || wantsNew(await searchParams)}>
          <NewStoryForm org={membership.slug} />
        </NewItem>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver los relatos, pero no crearlos ni cambiarlos.
        </p>
      )}

      {stories.length === 0 ? (
        <p className="notice">Todavía no hay relatos.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table-cards">
            <caption className="visually-hidden">Relatos de {membership.displayName}</caption>
            <thead>
              <tr>
                <th scope="col">Relato</th>
                <th scope="col">Lo cuenta</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {stories.map((story) => (
                <tr key={story.contentId}>
                  <td>
                    <Link href={`/o/${membership.slug}/memoria/${story.contentId}`}>
                      {story.title}
                    </Link>
                  </td>
                  <td data-label="Lo cuenta">{story.teller ?? "Sin indicar"}</td>
                  <td data-label="Estado">
                    <span
                      className="status-pill"
                      data-status={story.status === "retired" ? "draft" : story.status}
                    >
                      {STATUS[story.status].label}
                    </span>
                    <span className="cell-detail">{STATUS[story.status].detail}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
