-- P2 · Paso 3: panoramas are a new kind of media, processed by a durable job. The enum
-- values live in their own migration so they are committed before anything uses them.
alter type public.asset_purpose add value if not exists 'panorama';
alter type public.asset_version_status add value if not exists 'processing';
