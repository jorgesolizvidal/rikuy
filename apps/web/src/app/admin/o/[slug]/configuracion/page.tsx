import "@fontsource-variable/bricolage-grotesque";

import { loadBrandingEditor, ROLE_LABELS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";
import { platformSettings } from "@/server/platform";

import { SignOutButton } from "../../../sign-out-button";
import { BrandingForm } from "./branding-form";
import { valuesFromPresentation } from "./branding-fields";

export const metadata: Metadata = { title: "Marca del portal" };

interface BrandingPageProps {
  readonly params: Promise<{ slug: string }>;
}

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "long",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

export default async function BrandingPage({ params }: BrandingPageProps) {
  const membership = await requireOrganization((await params).slug);
  const editor = await loadBrandingEditor(membership, (await adminSession()).config);
  const portalUrl = editor.portalHostname
    ? platformSettings().portalOrigin(editor.portalHostname)
    : null;

  return (
    <main className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">Marca del portal</h1>
        <p className="lead">
          {editor.published
            ? `Versión ${editor.published.version} publicada el ${DATE.format(new Date(editor.published.sealedAt))}`
            : "Todavía no hay una versión publicada: el portal usa una marca neutra"}
          .{editor.draft ? " Hay un borrador con cambios sin publicar." : ""}
        </p>
        {portalUrl ? (
          <p>
            <a href={portalUrl} target="_blank" rel="noopener noreferrer">
              Ver el portal<span className="visually-hidden"> (se abre en otra pestaña)</span>
            </a>
          </p>
        ) : null}
      </div>

      {editor.canEdit ? null : (
        <p className="notice" role="status">
          Tu rol ({ROLE_LABELS[membership.role]}) puede ver la marca, pero solo propietarios y
          administradores pueden cambiarla.
        </p>
      )}

      <BrandingForm
        slug={membership.slug}
        initial={valuesFromPresentation(editor.initial)}
        revision={editor.draft?.revision ?? null}
        canEdit={editor.canEdit}
      />
    </main>
  );
}
