import { assistantPersona } from "@rikuy/core";

import { aiGatewayStatus } from "@/server/ai-gateway";
import { portalViewWith } from "@/server/portal-view";

interface BrandContext {
  readonly params: Promise<{ host: string }>;
}

export const dynamic = "force-dynamic";

const REFUSED = { "cache-control": "no-store", vary: "Origin" };

/**
 * What the line in the municipality's website asks first (ADR-071): the button's words and
 * colors. Only an authorized website gets an answer it can read (CORS): anywhere else the
 * script shows nothing. The municipality's websites come from the registry, not the request.
 */
export async function GET(request: Request, { params }: BrandContext) {
  const view = await portalViewWith((await params).host, "assistant");
  if (view === null || !aiGatewayStatus().configured) {
    return Response.json({ status: "not_found" }, { status: 404, headers: REFUSED });
  }
  const origin = request.headers.get("origin");
  const allowed = view.context.tenant.embedOrigins ?? [];
  if (origin === null || !allowed.includes(origin)) {
    return Response.json({ status: "forbidden" }, { status: 403, headers: REFUSED });
  }
  const { presentation, palette } = view.resolved;
  const persona = assistantPersona(presentation);
  const siteName = presentation.identity.siteName;
  return Response.json(
    {
      label: persona.named ? `Pregúntale a ${persona.name}` : "Pregúntale al asistente",
      title: persona.named
        ? `${persona.name}, asistente de ${siteName}`
        : `Asistente de ${siteName}`,
      // Validated #rrggbb values (ADR-061): the script writes them into its own styles.
      brand: palette.brand,
      onBrand: palette.onBrand,
      focus: palette.accent,
    },
    {
      headers: {
        "access-control-allow-origin": origin,
        vary: "Origin",
        "cache-control": "private, max-age=300",
      },
    },
  );
}
