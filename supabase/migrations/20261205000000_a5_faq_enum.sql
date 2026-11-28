-- A · Paso 5.2 (ADR-074): a frequently asked question is a kind of content. Its own migration:
-- a new enum value cannot be used in the transaction that adds it.

alter type public.content_kind add value if not exists 'faq';
