import { DICTATION_LIMITS } from "@rikuy/core";

/**
 * Meta's WhatsApp Cloud API (ADR-075), with fetch and no SDK: send a text message from a
 * municipality's number and download a voice note a visitor sent. One Meta app for the
 * platform: its access token travels only in the Authorization header and never reaches an
 * error or a log; Meta's error bodies are not read into errors (they can echo the request).
 */

export const WHATSAPP_GRAPH = "https://graph.facebook.com/v23.0";

export interface WhatsAppCloudOptions {
  readonly accessToken: string;
  /** A local stand-in for tests (never in production: the configuration refuses it). */
  readonly graphUrl?: string;
  /** For tests. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface WhatsAppCloud {
  sendText(phoneNumberId: string, to: string, body: string): Promise<void>;
  /** The audio's bytes and MIME type; null when it is larger than a dictation may be. */
  downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string | null } | null>;
}

export class WhatsAppCloudError extends Error {
  constructor(
    readonly operation: "send" | "media",
    readonly status: number,
  ) {
    super(`WhatsApp ${operation} failed (${status})`);
    this.name = "WhatsAppCloudError";
  }
}

const DIGITS = /^[0-9]{5,30}$/u;
const MEDIA_ID = /^[0-9A-Za-z_-]{1,100}$/u;

async function readLimited(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createWhatsAppCloud(options: WhatsAppCloudOptions): WhatsAppCloud {
  const send = options.fetch ?? fetch;
  const base = (options.graphUrl ?? WHATSAPP_GRAPH).replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const auth = { authorization: `Bearer ${options.accessToken}` };

  return {
    async sendText(phoneNumberId, to, body) {
      if (!DIGITS.test(phoneNumberId) || !DIGITS.test(to)) throw new Error("Invalid WhatsApp id");
      const response = await send(`${base}/${phoneNumberId}/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body },
        }),
      });
      if (!response.ok) throw new WhatsAppCloudError("send", response.status);
      await response.body?.cancel();
    },

    async downloadMedia(mediaId) {
      if (!MEDIA_ID.test(mediaId)) throw new Error("Invalid media id");
      const meta = await send(`${base}/${mediaId}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: auth,
      });
      if (!meta.ok) throw new WhatsAppCloudError("media", meta.status);
      const info = (await meta.json().catch(() => null)) as {
        url?: unknown;
        mime_type?: unknown;
        file_size?: unknown;
      } | null;
      if (!info || typeof info.url !== "string" || !/^https?:\/\//u.test(info.url)) {
        throw new WhatsAppCloudError("media", meta.status);
      }
      if (typeof info.file_size === "number" && info.file_size > DICTATION_LIMITS.maxBytes) {
        return null;
      }
      const file = await send(info.url, { signal: AbortSignal.timeout(timeoutMs), headers: auth });
      if (!file.ok) throw new WhatsAppCloudError("media", file.status);
      const bytes = await readLimited(file, DICTATION_LIMITS.maxBytes);
      if (bytes === null) return null;
      return { bytes, mimeType: typeof info.mime_type === "string" ? info.mime_type : null };
    },
  };
}
