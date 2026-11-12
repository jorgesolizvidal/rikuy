import { PORTAL_PATHS, assistantPersona } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { aiGatewayStatus } from "@/server/ai-gateway";
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
  const assistant = aiGatewayStatus().configured ? assistantPersona(presentation).name : null;

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
          Para saber si el portal carga rápido, tu navegador envía métricas anónimas de velocidad
          (cuánto tarda en mostrarse la página) a Vercel, el servicio que aloja el portal. No usa
          cookies ni identifica a quien visita.
        </li>
        <li>
          Los mapas se dibujan con imágenes de OpenFreeMap, a partir de datos de OpenStreetMap. Al
          ver un mapa, tu navegador se las pide directamente a ese servicio, que recibe tu dirección
          IP como cualquier sitio web; no le enviamos tu ubicación ni otros datos.
        </li>
      </ul>

      <h2>Estadísticas de visitas</h2>
      <p>
        Para que {siteName} sepa qué lugares, eventos y recorridos interesan más, el portal cuenta
        las visitas de forma anónima, sin cookies y sin guardar nada en tu teléfono.
      </p>
      <ul>
        <li>
          Al abrir una página, al ver una escena de un recorrido 360° y al tocar «Cómo llegar»,
          «Compartir» o «Añadir al calendario», tu navegador avisa a la plataforma qué fue. Si
          llegaste escaneando un código QR de un cartel, también se cuenta el escaneo.
        </li>
        <li>
          Se guardan solo totales por día (por ejemplo, «el museo tuvo 40 visitas el lunes») y el
          país y la ciudad aproximados de donde vienen las visitas, que el servicio que aloja el
          portal estima a partir de la conexión. No se guarda tu dirección IP ni nada que te
          identifique.
        </li>
        <li>
          El equipo de {siteName} ve esos totales en su panel y puede descargarlos; no ve nada sobre
          una persona en particular.
        </li>
        <li>
          Para contar cuántas personas distintas visitaron el portal en un día, se usa una huella
          calculada con tu dirección IP y tu navegador, mezclada con un valor que cambia cada día.
          Esa huella no permite saber quién eres, no se puede relacionar con la de otro día y se
          borra a los dos días.
        </li>
        <li>Los buscadores y los programas automáticos no se cuentan.</li>
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

      {assistant ? (
        <>
          <h2 id="asistente">El asistente ({assistant})</h2>
          <p>
            El botón «{assistant}» abre un asistente que responde tus preguntas con lo que{" "}
            {siteName} publicó en este portal. Solo funciona si le escribes o le dictas.
          </p>
          <ul>
            <li>
              La conversación se guarda solo en este dispositivo, en el navegador, durante 24 horas
              como máximo. «Nueva conversación» la borra.
            </li>
            <li>
              Con cada pregunta se envían al portal la pregunta, los últimos mensajes de la
              conversación y la página donde estás (dentro de un tour 360°, también qué escena y qué
              punto tienes abiertos). El portal busca la respuesta en lo publicado y la redacta con
              un modelo de inteligencia artificial de Groq, que recibe ese texto para responder. No
              se envían tu nombre ni tu ubicación.
            </li>
            <li>
              «¿Qué hay cerca?», «Plan para hoy» y «Ruta sugerida» arman la lista con los horarios y
              las fechas publicados. Si usas tu ubicación, tu teléfono mide la distancia en línea
              recta a cada lugar del portal y envía solo esas distancias, redondeadas a 100 metros,
              nunca tus coordenadas. Con varias distancias se podría estimar dónde estás, con un
              margen de unos cien metros: por eso no se guardan ni se envían a Groq, que recibe solo
              los lugares elegidos.
            </li>
            <li>
              Ni {siteName} ni la plataforma guardan las respuestas, ni las preguntas que el
              asistente responde: solo cuántas se responden, cuánto tardan y cuánto cuestan. Para
              limitar el uso a 10 preguntas por hora, se cuenta tu dirección IP con una huella que
              cambia cada día.
            </li>
            <li>
              Cuando el asistente no encuentra nada publicado para responder, se guarda el texto de
              esa pregunta (y la página donde la hiciste) para que el equipo de {siteName} sepa qué
              falta publicar. Se guarda sin nada que te identifique: los correos, teléfonos, números
              de documento y enlaces se reemplazan antes de guardarla. Se borra a los 90 días. No
              escribas tu nombre ni otros datos personales en las preguntas.
            </li>
            <li>
              Si tocas el micrófono para dictar, el navegador te pide permiso y graba solo mientras
              lo tienes activado, hasta 30 segundos. La grabación se envía al portal y de ahí a
              Groq, que la pasa a texto; ese texto aparece en el campo de la pregunta para que lo
              revises antes de enviarlo. Ni la grabación ni el texto se guardan. Para limitar el uso
              a 10 dictados por hora, se cuenta tu dirección IP con la misma huella diaria.
            </li>
            <li>
              «Escuchar» lee la respuesta en voz alta con una voz de tu propio dispositivo: el texto
              no sale del navegador. Si la pregunta fue dictada, la respuesta se lee sola; puedes
              detenerla cuando quieras.
            </li>
            <li>
              Las respuestas las genera una inteligencia artificial y pueden tener errores. Cada
              respuesta indica de qué página del portal sale; ante la duda, revísala o consulta al
              municipio.
            </li>
          </ul>
        </>
      ) : null}

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
