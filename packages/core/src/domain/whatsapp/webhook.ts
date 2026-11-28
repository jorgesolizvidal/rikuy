import { z } from "zod";

/**
 * What Meta relays to the webhook (ADR-075): the messages visitors send to a municipality's
 * WhatsApp number. Meta signs the body (checked before this, on the raw bytes); this only reads
 * its shape. Delivery statuses and anything that is not a message are left out. Every field is
 * read defensively: an unexpected shape is no message, never an error.
 */

export type WhatsAppInboundKind = "text" | "audio" | "location" | "other";

export interface WhatsAppInbound {
  /** The municipality's number the visitor wrote to (Meta's «phone number ID»). */
  readonly phoneNumberId: string;
  /** Meta's message ID («wamid…»): each message is answered once. */
  readonly messageId: string;
  /** The visitor's WhatsApp ID (their number, digits only): used to answer, never stored. */
  readonly from: string;
  readonly kind: WhatsAppInboundKind;
  readonly text: string | null;
  /** A voice note or audio file, to download from Meta. */
  readonly mediaId: string | null;
  /** A shared location: used to measure distances, then forgotten. */
  readonly location: { readonly lat: number; readonly lng: number } | null;
}

const messageSchema = z.object({
  from: z.string().regex(/^[0-9]{5,20}$/u),
  id: z.string().min(1).max(200),
  type: z.string().max(40),
  text: z.object({ body: z.string().max(4096) }).optional(),
  audio: z.object({ id: z.string().regex(/^[0-9A-Za-z_-]{1,100}$/u) }).optional(),
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
});

const payloadSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string().regex(/^[0-9]{5,30}$/u) }),
                messages: z.array(z.unknown()).max(100).optional(),
              }),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});

/** At most this many messages of one delivery are answered (Meta sends one, rarely a few). */
export const WHATSAPP_MESSAGES_PER_DELIVERY = 20;

export function parseWhatsAppWebhook(raw: unknown): WhatsAppInbound[] {
  const payload = payloadSchema.safeParse(raw);
  if (!payload.success) return [];
  const inbound: WhatsAppInbound[] = [];
  for (const entry of payload.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const phoneNumberId = change.value.metadata.phone_number_id;
      for (const candidate of change.value.messages ?? []) {
        const message = messageSchema.safeParse(candidate);
        if (!message.success) continue;
        const { from, id, type } = message.data;
        const base = { phoneNumberId, messageId: id, from };
        if (type === "text" && message.data.text) {
          inbound.push({
            ...base,
            kind: "text",
            text: message.data.text.body,
            mediaId: null,
            location: null,
          });
        } else if (type === "audio" && message.data.audio) {
          inbound.push({
            ...base,
            kind: "audio",
            text: null,
            mediaId: message.data.audio.id,
            location: null,
          });
        } else if (type === "location" && message.data.location) {
          inbound.push({
            ...base,
            kind: "location",
            text: null,
            mediaId: null,
            location: {
              lat: message.data.location.latitude,
              lng: message.data.location.longitude,
            },
          });
        } else {
          inbound.push({ ...base, kind: "other", text: null, mediaId: null, location: null });
        }
        if (inbound.length >= WHATSAPP_MESSAGES_PER_DELIVERY) return inbound;
      }
    }
  }
  return inbound;
}
