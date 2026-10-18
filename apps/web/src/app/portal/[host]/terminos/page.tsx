import { PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalView } from "@/server/portal-view";

import { LegalContact } from "../legal-contact";

interface LegalPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: LegalPageProps): Promise<Metadata> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  return {
    title: "Términos de uso",
    description: `Condiciones de uso del portal de ${view.resolved.presentation.identity.siteName}.`,
    alternates: { canonical: PORTAL_PATHS.terms },
  };
}

/** Platform template filled with the municipality's published data. */
export default async function TermsPage({ params }: LegalPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  const { presentation } = view.resolved;
  const { siteName } = presentation.identity;

  return (
    <article className="portal-page portal-prose portal-legal">
      <h1 className="portal-page-title">Términos de uso</h1>
      <p className="portal-lead">
        Este portal ofrece, de forma gratuita, información turística publicada por {siteName}.
      </p>

      <h2>La información del portal</h2>
      <p>
        {siteName} procura mantener la información al día, pero horarios, accesos, precios y
        condiciones pueden cambiar sin aviso. Antes de viajar, confirma lo importante con los
        canales oficiales, sobre todo caminos y clima.
      </p>

      <h2>Cómo llegar y desplazamientos</h2>
      <p>
        Las indicaciones de «Cómo llegar» las calcula un servicio externo de mapas. Respeta la
        señalización, las normas de tránsito y las indicaciones de las autoridades locales.
      </p>

      <h2>Textos y fotos</h2>
      <p>
        Los textos y las fotos pertenecen a {siteName} o a sus autores. Puedes compartir los enlaces
        libremente; para reutilizar fotos o textos en otro lugar, pide autorización.
      </p>

      <h2>Enlaces a otros sitios</h2>
      <p>
        Los enlaces a sitios de terceros se ofrecen como ayuda. {siteName} no controla su contenido
        ni sus condiciones.
      </p>

      <h2>Cambios</h2>
      <p>
        Estos términos pueden actualizarse cuando el portal sume funciones. La versión vigente es
        siempre la que ves en esta página.
      </p>

      <h2>Contacto</h2>
      <LegalContact presentation={presentation} />

      <p className="portal-legal-note">
        Texto basado en la plantilla de la plataforma Rikuy, completado con los datos de {siteName}.
      </p>
    </article>
  );
}
