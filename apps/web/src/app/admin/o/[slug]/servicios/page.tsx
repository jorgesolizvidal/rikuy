import { canEditContent, listServices, SERVICE_CATEGORY_INFO } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { NewItem, wantsNew } from "@/components/panel/new-item";
import { adminSession } from "@/server/admin-session";
import { requireModule } from "@/server/organization";

import { NewServiceForm } from "./service-forms";

export const metadata: Metadata = { title: "Servicios locales" };

const STATUS = {
  published: { label: "Publicado", detail: "Se ve en el portal y el asistente lo usa" },
  changed: { label: "Con cambios", detail: "Publicado, con cambios sin publicar" },
  draft: { label: "Borrador", detail: "Nunca publicado" },
  retired: { label: "Retirado", detail: "Ya no se ve (por ejemplo, cerró)" },
} as const;

interface ServicesPageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ nuevo?: string | string[] }>;
}

export default async function ServicesPage({ params, searchParams }: ServicesPageProps) {
  const membership = await requireModule((await params).slug, "services");
  const services = await listServices(membership, (await adminSession()).services);
  const canEdit = canEditContent(membership.role);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <div className="branding-heading">
        <h1 className="title title-sm">Servicios locales</h1>
        <p className="lead">
          Dónde comer, dormir, sacar dinero, cargar gasolina o tomar transporte en{" "}
          {membership.displayName}, con su horario y cómo comunicarse. Se ven en la página
          «Servicios» del portal y en el mapa, y el asistente los usa para responder.
        </p>
      </div>

      {canEdit ? (
        <NewItem
          label="Nuevo servicio"
          open={services.length === 0 || wantsNew(await searchParams)}
        >
          <NewServiceForm org={membership.slug} />
        </NewItem>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver los servicios, pero no crearlos ni cambiarlos.
        </p>
      )}

      {services.length === 0 ? (
        <p className="notice">Todavía no hay servicios.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table-cards">
            <caption className="visually-hidden">Servicios de {membership.displayName}</caption>
            <thead>
              <tr>
                <th scope="col">Servicio</th>
                <th scope="col">Categoría</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.contentId}>
                  <td>
                    <Link href={`/o/${membership.slug}/servicios/${service.contentId}`}>
                      {service.title}
                    </Link>
                  </td>
                  <td data-label="Categoría">
                    {service.category ? SERVICE_CATEGORY_INFO[service.category].name : "Sin elegir"}
                  </td>
                  <td data-label="Estado">
                    <span
                      className="status-pill"
                      data-status={service.status === "retired" ? "draft" : service.status}
                    >
                      {STATUS[service.status].label}
                    </span>
                    <span className="cell-detail">{STATUS[service.status].detail}</span>
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
