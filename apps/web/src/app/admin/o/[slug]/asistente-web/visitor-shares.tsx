import {
  hasModule,
  loadContentWebLink,
  PORTAL_PATHS,
  type OrganizationMembership,
} from "@rikuy/core";

import { adminSession } from "@/server/admin-session";
import { aiGatewayStatus } from "@/server/ai-gateway";
import { platformSettings } from "@/server/platform";

import { PortalShare } from "../destinos/[id]/portal-share";
import { AskShare } from "./ask-share";
import { WebLinkField } from "./web-link-field";

/**
 * «Página en la web del municipio» of an item (ADR-071), when the municipality has authorized
 * websites. Notices, services and stories show it alone; destinations and events inside
 * «Para visitantes».
 */
export async function ContentWebLink({
  membership,
  contentId,
}: {
  readonly membership: OrganizationMembership;
  readonly contentId: string;
}) {
  const { embed } = await adminSession();
  const link = await loadContentWebLink(membership, contentId, embed).catch(() => null);
  if (link === null) return null;
  return (
    <WebLinkField
      org={membership.slug}
      contentId={contentId}
      url={link.url}
      origins={link.origins}
      canChange={link.canChange}
    />
  );
}

/**
 * «Para visitantes» of a published destination or event: its page on the portal with its QR
 * (with the portal), «Pregúntale a …» with its QR (with the assistant, ADR-071) and its page on
 * the municipality's website.
 */
export async function VisitorShares({
  membership,
  kind,
  contentId,
  slug,
  title,
  portalPath,
}: {
  readonly membership: OrganizationMembership;
  readonly kind: "destination" | "event";
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  /** Where it is on the portal, once published (null: not published yet). */
  readonly portalPath: { readonly hostname: string; readonly path: string } | null;
}) {
  const online = membership.tenantStatus === "active";
  const origin = portalPath ? platformSettings().portalOrigin(portalPath.hostname) : null;
  const ask =
    origin && hasModule(membership.modules, "assistant") && aiGatewayStatus().configured
      ? `${origin}${PORTAL_PATHS.askAbout(kind, slug)}`
      : null;
  return (
    <>
      {origin && portalPath && hasModule(membership.modules, "portal") ? (
        <PortalShare
          url={`${origin}${portalPath.path}`}
          slug={slug}
          title={title}
          portalOnline={online}
        />
      ) : null}
      {ask ? (
        <AskShare
          url={ask}
          fileName={`pregunta-${slug}`}
          assistantName={null}
          about={kind === "event" ? "este evento" : "este lugar"}
          online={online}
        />
      ) : null}
      <ContentWebLink membership={membership} contentId={contentId} />
    </>
  );
}
