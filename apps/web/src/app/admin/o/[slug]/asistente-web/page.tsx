import { hasModule, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";

import { adminSession } from "@/server/admin-session";
import { aiGatewayStatus } from "@/server/ai-gateway";
import { requireModule } from "@/server/organization";
import { platformSettings } from "@/server/platform";

import { AskShare } from "./ask-share";
import { WhatsAppShare } from "./whatsapp-share";

export const metadata: Metadata = { title: "Asistente en tu web" };

interface EmbedPageProps {
  readonly params: Promise<{ slug: string }>;
}

/**
 * «Asistente en tu web» (A · Paso 2, ADR-071): the websites where the assistant may be shown
 * (the platform operator authorizes them), the line to paste into them, and «Pregúntale a …»
 * for the whole municipality with its QR code.
 */
export default async function AssistantOnWebsitePage({ params }: EmbedPageProps) {
  const membership = await requireModule((await params).slug, "assistant");
  const session = await adminSession();
  const [origins, hostname, numbers] = await Promise.all([
    session.embed.origins(membership.tenantId).catch(() => []),
    session.content.portalHostname(membership.tenantId).catch(() => null),
    session.whatsapp.numbers(membership.tenantId).catch(() => []),
  ]);
  const portalOrigin = hostname ? platformSettings().portalOrigin(hostname) : null;
  const line = portalOrigin
    ? `<script src="${portalOrigin}${PORTAL_PATHS.embedScript}" async></script>`
    : null;
  const example = portalOrigin
    ? `<script src="${portalOrigin}${PORTAL_PATHS.embedScript}" data-lugar="destinos/museo" async></script>`
    : null;
  const configured = aiGatewayStatus().configured;

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <div className="branding-heading">
        <h1 className="title title-sm">Asistente en tu web</h1>
        <p className="lead">
          El asistente de {membership.displayName} también puede estar en la web propia del
          municipio, con un botón que abre la conversación, en carteles con un código QR y en
          WhatsApp.
          {hasModule(membership.modules, "portal")
            ? null
            : " Este municipio no tiene portal en Rikuy: las respuestas llevan a las páginas de su web."}
        </p>
      </div>

      <section aria-labelledby="webs" className="embed-section">
        <h2 id="webs">Webs autorizadas</h2>
        {origins.length === 0 ? (
          <p className="notice">
            Todavía no hay ninguna. El operador de Rikuy autoriza la dirección de la web del
            municipio; en cualquier otra web el asistente no se muestra.
          </p>
        ) : (
          <>
            <ul className="embed-origins">
              {origins.map((origin) => (
                <li key={origin}>
                  <code>{origin}</code>
                </li>
              ))}
            </ul>
            <p className="field-hint">
              Solo en estas webs aparece el botón del asistente. Para agregar o quitar una, habla
              con el operador de Rikuy.
            </p>
          </>
        )}
      </section>

      {origins.length > 0 && line && example ? (
        <section aria-labelledby="linea" className="embed-section">
          <h2 id="linea">La línea para tu web</h2>
          <p>
            Pégala una vez en la plantilla de la web (antes de <code>&lt;/body&gt;</code>): aparece
            el botón «Pregúntale a …» en todas sus páginas.
          </p>
          <pre className="embed-code">
            <code>{line}</code>
          </pre>
          <p>
            En la página de la web que habla de un lugar, agrega <code>data-lugar</code> con su
            dirección en Rikuy (<code>destinos/…</code> o <code>agenda/…</code>): el asistente
            responde ya sabiendo de qué lugar se trata.
          </p>
          <pre className="embed-code">
            <code>{example}</code>
          </pre>
          <p className="field-hint">
            En cada destino, evento, aviso, servicio y relato puedes poner su «Página en la web del
            municipio»: las respuestas del asistente llevan ahí.
          </p>
        </section>
      ) : null}

      {portalOrigin && configured ? (
        <AskShare
          url={`${portalOrigin}${PORTAL_PATHS.ask}`}
          fileName={`pregunta-${membership.slug}`}
          assistantName={null}
          about={null}
          online={membership.tenantStatus === "active"}
        />
      ) : null}
      <WhatsAppShare numbers={numbers} fileName={`whatsapp-${membership.slug}`} />
      {configured ? null : (
        <p className="notice" role="status">
          La plataforma todavía no tiene la inteligencia artificial configurada: el asistente no
          responde en ningún lado.
        </p>
      )}
    </main>
  );
}
