-- A · Paso 1.1 (ADR-069): the municipality's notices are a kind of content. The new enum
-- value is committed here, before the next migration uses it.

alter type public.content_kind add value if not exists 'notice';
