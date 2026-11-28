import "server-only";

import {
  answerWhatsApp,
  DICTATION_MESSAGES,
  helpDeskOf,
  parseWhatsAppWebhook,
  whatsappReplyText,
  type WhatsAppAssistant,
  type WhatsAppDeps,
  type WhatsAppInbound,
  type WhatsAppOutcome,
} from "@rikuy/core";

import {
  downloadWhatsAppAudio,
  recordAssistantTurn,
  recordUnansweredQuestion,
  sendWhatsAppText,
  whatsappBegin,
  whatsappLogger,
  whatsappRemember,
} from "./ai-gateway";
import { askPortalAssistant, linkAnswer, transcribePortalDictation } from "./portal-assistant";
import { portalOrigin, portalPlanPlaces } from "./portal-content";
import { portalHas, portalView, type PortalView } from "./portal-view";

/**
 * A municipality's assistant on WhatsApp (A · Paso 6, ADR-075). Meta relays each message to
 * the platform's webhook; the municipality is the one the number belongs to (the database
 * says so, never the message), and the answer comes from the same assistant as the portal,
 * with the channel «Por WhatsApp» in its metrics. Links are absolute: to the portal, or to
 * the municipality's website when it has no public portal (ADR-071).
 */

function assistantFor(view: PortalView): WhatsAppAssistant {
  const tenantId = view.context.tenant.tenantId;
  return {
    ask: (request, visitor) => askPortalAssistant(view, request, visitor),
    transcribe: portalHas(view, "voice")
      ? async (mediaId, visitor) => {
          const audio = await downloadWhatsAppAudio(mediaId);
          if (audio === null) return { status: "invalid", message: DICTATION_MESSAGES.too_long };
          return (await transcribePortalDictation(view, audio, visitor)).reply;
        }
      : null,
    places: () => portalPlanPlaces(view),
    async format(result, question) {
      const { reply } = await linkAnswer(view, "portal", result.reply, []);
      const presentation = view.resolved.presentation;
      return whatsappReplyText(reply, {
        origin: portalHas(view, "portal") ? portalOrigin(view) : null,
        siteName: presentation.identity.siteName,
        desk: helpDeskOf(presentation),
        question,
        timezone: view.context.tenant.timezone,
        now: new Date(),
      });
    },
    async recordTurn(result) {
      if (result.turn) await recordAssistantTurn(tenantId, "whatsapp", result.turn);
    },
    async recordUnanswered(result) {
      if (result.unanswered) await recordUnansweredQuestion(tenantId, result.unanswered);
    },
  };
}

const deps: WhatsAppDeps = {
  begin: (message) => whatsappBegin(message.phoneNumberId, message.messageId, message.from),
  async open(begun) {
    const view = await portalView(begun.host);
    if (view === null || view.context.tenant.tenantId !== begun.tenantId) return null;
    return portalHas(view, "assistant") ? assistantFor(view) : null;
  },
  send: sendWhatsAppText,
  remember: whatsappRemember,
};

async function answerOne(message: WhatsAppInbound): Promise<WhatsAppOutcome | "failed"> {
  try {
    return await answerWhatsApp(message, deps);
  } catch (error) {
    // Never the message, the number or Meta's answer: only what kind of failure it was.
    whatsappLogger.event("whatsapp.failed", {
      error: error instanceof Error ? error.name : "unknown",
      status:
        typeof (error as { status?: unknown } | null)?.status === "number"
          ? (error as { status: number }).status
          : null,
    });
    return "failed";
  }
}

/** Every message of one delivery, one after another (a visitor's messages keep their order). */
export async function handleWhatsAppDelivery(raw: unknown): Promise<void> {
  for (const message of parseWhatsAppWebhook(raw)) {
    const outcome = await answerOne(message);
    whatsappLogger.event("whatsapp.message", { kind: message.kind, outcome });
  }
}
