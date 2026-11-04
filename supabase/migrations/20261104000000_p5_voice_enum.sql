-- ─────────────────────────────────────────────────────────────────────────────
-- P5 · Paso 6 — seconds of dictated audio as a quota resource (ADR-041).
--
-- On its own migration: a new enum value cannot be used in the transaction that adds it.
-- The next migration redefines the existing readers (tenant_usage, platform_tenant_usage,
-- the operations snapshot) so they keep returning only storage and compute.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

alter type public.usage_resource add value if not exists 'ai_audio_seconds';
