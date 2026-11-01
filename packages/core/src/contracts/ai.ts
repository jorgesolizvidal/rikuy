/**
 * The AI gateway (ADR-036): every call to a model goes through one place that counts what
 * it uses, stops in time and leaves the portal working when AI is not there.
 */

/** What a request is for. Each has its limits; all use the same model in the pilot (D4). */
export const AI_PROFILES = ["assistant", "copilot", "probe"] as const;
export type AiProfile = (typeof AI_PROFILES)[number];

export interface AiProfileSettings {
  /** Estimated tokens of the messages sent; a larger request is a caller's mistake. */
  readonly maxInputTokens: number;
  /**
   * The most the model may answer, its brief reasoning included (gpt-oss reasons before
   * answering; the provider is asked for low effort). Also what the reservation adds.
   */
  readonly maxOutputTokens: number;
  /** For each call to the provider. */
  readonly timeoutMs: number;
  readonly temperature: number;
}

export const AI_PROFILE_SETTINGS: Readonly<Record<AiProfile, AiProfileSettings>> = {
  // The visitor's assistant in the portal and the tours (P5 · Pasos 3–6).
  assistant: { maxInputTokens: 6000, maxOutputTokens: 1000, timeoutMs: 20_000, temperature: 0.2 },
  // The staff's assistant in the panel (P5 · Paso 7).
  copilot: { maxInputTokens: 12_000, maxOutputTokens: 2000, timeoutMs: 30_000, temperature: 0.2 },
  // «Probar la IA» in /plataforma: the smallest request that proves the key and the quota.
  probe: { maxInputTokens: 200, maxOutputTokens: 256, timeoutMs: 15_000, temperature: 0 },
};

export interface AiMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Why a request got no answer; the visitor gets a friendly notice for each (never an error). */
export type AiRefusal =
  /** The municipality used its AI quota of the day. */
  | "tenant_quota"
  /** The platform used its daily share of the provider. */
  | "platform_quota"
  /** This visitor asked too much in the last hour. */
  | "visitor_limit"
  /** Suspended, or not online for the visitor assistant. */
  | "tenant_unavailable"
  /** The provider is down, slow or saturated. */
  | "provider_unavailable"
  /** The provider refused the request (configuration or a bad request). */
  | "provider_error"
  /** No AI on this deployment (no key or no gateway connection), or the gateway is down. */
  | "not_configured";

export interface AiUsageCount {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type AiResult =
  | {
      readonly outcome: "answered";
      readonly requestId: string;
      readonly text: string;
      readonly model: string;
      readonly usage: AiUsageCount;
      readonly latencyMs: number;
    }
  | {
      readonly outcome: AiRefusal;
      /** Null when nothing was recorded (no AI configured or the gateway is unreachable). */
      readonly requestId: string | null;
    };

/** A municipality's AI usage today (any member). */
export interface AiUsageView {
  readonly limit: number;
  /** Set aside by requests in progress. */
  readonly reserved: number;
  readonly consumed: number;
  /** ISO: today's midnight and tomorrow's, in the municipality's time zone. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly answeredToday: number;
  readonly refusedToday: number;
}

/** One municipality's AI usage today, for the platform operator. */
export interface PlatformAiUsageRow extends AiUsageView {
  readonly tenantId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: "provisioning" | "active" | "suspended";
  /** No limit assigned to this municipality: the platform default applies. */
  readonly isDefault: boolean;
}
