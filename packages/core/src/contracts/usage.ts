/**
 * Quotas per municipality (P2 · Paso 5): what a municipality may use and what it used.
 * Storage counts originals and derivatives, with no period; media compute counts the
 * processing time of panoramas and 3D models per calendar month; AI counts the tokens of
 * its requests per day (ADR-036). Periods follow the municipality's time zone.
 */
export const USAGE_RESOURCES = ["storage_bytes", "media_compute_seconds", "ai_tokens"] as const;
export type UsageResource = (typeof USAGE_RESOURCES)[number];

export const QUOTA_DEFAULTS: Readonly<Record<UsageResource, number>> = {
  storage_bytes: 300 * 1024 * 1024,
  media_compute_seconds: 30 * 60,
  ai_tokens: 40_000,
};

/** The whole platform's AI tokens per UTC day: 90 % of Groq's free plan (ADR-036). */
export const AI_PLATFORM_DAILY_LIMIT = 180_000;

/** At this share of the limit the panel warns before uploads start being refused. */
export const QUOTA_WARNING_SHARE = 0.8;

export interface UsageView {
  readonly resource: UsageResource;
  readonly limit: number;
  /** Set aside by uploads and jobs still in progress (estimates, settled when they end). */
  readonly reserved: number;
  readonly consumed: number;
  /** ISO dates; null for resources without a period (storage). */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}

export type UsageLevel = "ok" | "near" | "full";
