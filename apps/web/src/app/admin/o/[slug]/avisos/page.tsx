import { canEditContent, describeNoticeValidity, listNotices } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { NewItem, wantsNew } from "@/components/panel/new-item";
import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { NewNoticeForm } from "./notice-forms";

export const metadata: Metadata = { title: "Avisos" };

/** The pill reuses the panel's states: in force = published, programmed = changed, … */
const STATE = {
  active: {
    label: "Vigente",
    pill: "published",
    detail: "Se ve en el portal y el asistente lo cita",
  },
  scheduled: {
    label: "Programado",
    pill: "changed",
    detail: "Empieza a verse en su fecha «desde»",
  },
  draft: { label: "Borrador", pill: "draft", detail: "Nunca publicado" },
  expired: { label: "Vencido", pill: "draft", detail: "Ya no se ve ni lo usa el asistente" },
  retired: { label: "Retirado", pill: "draft", detail: "Se retiró a mano" },
} as const;

interface NoticesPageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ nuevo?: string | string[] }>;
}

export default async function NoticesPage({ params, searchParams }: NoticesPageProps) {
  const membership = await requireOrganization((await params).slug);
  const notices = await listNotices(membership, new Date(), (await adminSession()).notices);
  const canEdit = canEditContent(membership.role);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <div className="branding-heading">
        <h1 className="title title-sm">Avisos</h1>
        <p className="lead">
          Lo que cambia en {membership.displayName}: un corte de ruta, una feria suspendida, un
          cambio de horario. Mientras está vigente, se ve arriba en todas las páginas del portal y
          el asistente lo dice primero. Al llegar su fecha «hasta» deja de verse solo.
        </p>
      </div>

      {canEdit ? (
        <NewItem label="Nuevo aviso" open={notices.length === 0 || wantsNew(await searchParams)}>
          <NewNoticeForm org={membership.slug} />
        </NewItem>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver los avisos, pero no crearlos ni cambiarlos.
        </p>
      )}

      {notices.length === 0 ? (
        <p className="notice">Todavía no hay avisos.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table-cards">
            <caption className="visually-hidden">Avisos de {membership.displayName}</caption>
            <thead>
              <tr>
                <th scope="col">Aviso</th>
                <th scope="col">Estado</th>
                <th scope="col">Vigencia</th>
              </tr>
            </thead>
            <tbody>
              {notices.map((notice) => (
                <tr key={notice.contentId}>
                  <td>
                    <Link href={`/o/${membership.slug}/avisos/${notice.contentId}`}>
                      {notice.title}
                    </Link>
                  </td>
                  <td data-label="Estado">
                    <span className="status-pill" data-status={STATE[notice.state].pill}>
                      {STATE[notice.state].label}
                    </span>
                    <span className="cell-detail">
                      {STATE[notice.state].detail}
                      {notice.changed ? " · con cambios sin publicar" : ""}
                    </span>
                  </td>
                  <td data-label="Vigencia">
                    {describeNoticeValidity(notice.published ?? notice.validity) ??
                      "Sin fecha de fin"}
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
