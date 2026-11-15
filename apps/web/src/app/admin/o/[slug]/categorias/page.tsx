import { hasModule, loadCategories } from "@rikuy/core";
import type { Metadata } from "next";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { CategoryList } from "./category-list";

export const metadata: Metadata = { title: "Categorías" };

interface CategoriesPageProps {
  readonly params: Promise<{ slug: string }>;
}

/**
 * C3 · Paso 3 (ADR-062): the municipality's categories. Any member sees them; owners and
 * admins change them. Each destination or event picks one in its editor.
 */
export default async function CategoriesPage({ params }: CategoriesPageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const view = await loadCategories(membership, { categories: session.categories });
  const agenda = hasModule(membership.modules, "agenda");

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <div className="branding-heading">
        <h1 className="title title-sm">Categorías</h1>
        <p className="lead">
          Agrupan los destinos{agenda ? " y los eventos" : ""} de {membership.displayName}. Los
          visitantes filtran las listas del portal por categoría. Cada destino
          {agenda ? " o evento" : ""} elige la suya en su editor; se muestra cuando se publica.
        </p>
      </div>
      {view.canManage ? null : (
        <p className="notice" role="status">
          Solo los propietarios y administradores cambian las categorías.
        </p>
      )}
      <section aria-labelledby="categorias-destinos" className="category-section">
        <h2 id="categorias-destinos">Categorías de destinos</h2>
        <CategoryList
          org={membership.slug}
          kind="destination"
          initial={view.destination}
          canManage={view.canManage}
          noun={["destino", "destinos"]}
        />
      </section>
      {agenda ? (
        <section aria-labelledby="categorias-eventos" className="category-section">
          <h2 id="categorias-eventos">Categorías de eventos</h2>
          <CategoryList
            org={membership.slug}
            kind="event"
            initial={view.event}
            canManage={view.canManage}
            noun={["evento", "eventos"]}
          />
        </section>
      ) : null}
      <p className="field-hint">
        Quitar una categoría no borra nada: los destinos y eventos que la tenían quedan sin
        categoría en el portal.
      </p>
    </main>
  );
}
