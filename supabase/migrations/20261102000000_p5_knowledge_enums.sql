-- P5 · Paso 2 (ADR-037): new enum values in their own migration, so the next one (which
-- uses them) runs after they are committed.
alter type public.content_kind add value if not exists 'knowledge';
alter type public.asset_purpose add value if not exists 'document';
