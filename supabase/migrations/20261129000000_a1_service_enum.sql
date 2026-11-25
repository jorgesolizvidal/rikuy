-- A · Paso 1.2 (ADR-069): local services are a kind of content. The new enum value is
-- committed here, before the next migration uses it.

alter type public.content_kind add value if not exists 'service';
