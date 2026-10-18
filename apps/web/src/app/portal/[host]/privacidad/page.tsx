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
    title: "Privacidad",
    description: `Qué datos trata el portal de ${view.resolved.presentation.identity.siteName} y para qué.`,
    alternates: { canonical: PORTAL_PATHS.privacy },
  };
}

/**
 * Platform template filled with the municipality's published data. It describes what the
 * portal actually does today; each step that changes it (location, assistant) updates it.
 */
export default async function PrivacyPage({ params }: LegalPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  const { presentation } = view.resolved;
  const { siteName } = presentation.identity;

  return (
    <article className="portal-page portal-prose portal-legal">
      <h1 className="portal-page-title">Privacidad</h1>
      <p className="portal-lead">
        Este portal es de {siteName}. Aquí explicamos qué datos se tratan cuando lo visitas.
      </p>

      <h2>Quién es responsable</h2>
      <p>
        {siteName} publica y es responsable del contenido de este portal. La plataforma Rikuy lo
        aloja y lo mantiene por encargo del municipio, y solo trata datos para que el portal
        funcione.
      </p>

      <h2>Qué datos se tratan al visitarlo</h2>
      <ul>
        <li>No necesitas crear una cuenta ni dar datos personales para ver el portal.</li>
        <li>No usamos cookies de seguimiento ni de publicidad.</li>
        <li>
          Como cualquier sitio web, los servidores registran datos técnicos de cada visita
          (dirección IP, navegador, página pedida y hora) para mantener el portal seguro y
          funcionando. Se conservan el tiempo mínimo necesario y no se usan para crear perfiles.
        </li>
        <li>Las fotos se sirven desde el almacenamiento de la plataforma.</li>
        <li>
          Los mapas se dibujan con imágenes de OpenFreeMap, a partir de datos de OpenStreetMap. Al
          ver un mapa, tu navegador se las pide directamente a ese servicio, que recibe tu dirección
          IP como cualquier sitio web; no le enviamos tu ubicación ni otros datos.
        </li>
      </ul>

      <h2>Tu ubicación</h2>
      <p>
        El portal puede mostrarte dónde estás en el mapa, a qué distancia queda cada lugar y
        avisarte cuando estás cerca de un destino. Solo lo hace si presionas «Usar mi ubicación»;
        entonces tu navegador te pide permiso.
      </p>
      <ul>
        <li>
          Tu ubicación se usa solo en tu dispositivo: las distancias, el orden por cercanía y el
          aviso «Estás cerca de…» se calculan ahí. No se envía a {siteName} ni a la plataforma y no
          se guarda.
        </li>
        <li>
          Solo se sigue mientras la página está abierta y a la vista; al cambiar de pestaña o
          bloquear el teléfono se detiene. No hay avisos en segundo plano ni historial de
          recorridos.
        </li>
        <li>
          Para no preguntarte en cada página, el navegador recuerda en esta pestaña que la activaste
          (no recuerda dónde estabas). «Dejar de usar mi ubicación» lo borra; también puedes quitar
          el permiso en los ajustes del navegador.
        </li>
        <li>
          Si el mapa se centra en tu posición, tu navegador pide a OpenFreeMap las imágenes de esa
          zona, como con cualquier mapa en línea.
        </li>
        <li>Sin permiso, el portal funciona igual: listas, fichas y mapa siguen disponibles.</li>
      </ul>

      <h2>Enlaces a otros servicios</h2>
      <p>
        «Cómo llegar» abre Google Maps, «Ver en OpenStreetMap» abre OpenStreetMap y los enlaces a
        redes sociales abren esas plataformas. Al usarlos se aplican sus propias políticas de
        privacidad.
      </p>

      <h2>Instalar el portal</h2>
      <p>
        Si instalas el portal en tu teléfono o computadora, solo se guarda un acceso directo en tu
        dispositivo. No concede permisos adicionales y puedes quitarlo cuando quieras.
      </p>

      <h2>Contacto</h2>
      <LegalContact presentation={presentation} />

      <p className="portal-legal-note">
        Texto basado en la plantilla de la plataforma Rikuy, completado con los datos de {siteName}.
      </p>
    </article>
  );
}
