-- A · Paso 1.3 (ADR-069): a story of the community is a kind of content. Its own migration:
-- a new enum value cannot be used in the transaction that adds it.

alter type public.content_kind add value if not exists 'story';
