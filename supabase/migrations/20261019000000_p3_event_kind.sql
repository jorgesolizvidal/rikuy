-- P3 · Paso 4: events are a new kind of editorial content. The enum value lives in its
-- own migration so it is committed before any function or row uses it.
alter type public.content_kind add value if not exists 'event';
