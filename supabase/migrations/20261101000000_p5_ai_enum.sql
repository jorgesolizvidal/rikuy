-- ─────────────────────────────────────────────────────────────────────────────
-- P5 · Paso 1 — AI tokens as a quota resource (ADR-036).
--
-- On its own migration: a new enum value cannot be used in the transaction that adds it.
-- The existing readers (tenant_usage, platform_tenant_usage, the operations snapshot) are
-- redefined by the next migration so they keep returning only storage and compute.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

alter type public.usage_resource add value if not exists 'ai_tokens';
