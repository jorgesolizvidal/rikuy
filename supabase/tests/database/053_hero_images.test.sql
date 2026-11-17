-- fix/hero-lcp (ADR-070): the hero versions of content photos, the portal's flag and the
-- job that makes them for photos uploaded before.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set a1  '00000000-0000-4000-8000-0000000000a1'
\set ta  'aaaaaaaa-0000-4000-8000-000000000001'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'

insert into auth.users (id, email) values (:'a1', 'owner.a@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now());
update public.tenants set status = 'active' where id = :'ta';
set constraints all immediate;
grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

-- Photos: with hero versions public (hero), without any (old), with them only private
-- (private), with only one of them public (half); a logo, a panorama and a rejected photo.
create temp table media (name text primary key, purpose public.asset_purpose, status public.asset_version_status,
                         asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, purpose, status) values
  ('hero', 'content', 'ready'), ('old', 'content', 'ready'), ('private', 'content', 'ready'),
  ('half', 'content', 'ready'), ('logo', 'logo', 'ready'), ('pano', 'panorama', 'ready'),
  ('gone', 'content', 'rejected');
insert into public.assets (id, tenant_id, purpose) select asset, :'ta', purpose from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                   mime, bytes, width, height, sha256, ready_at, published_at)
select version_id, :'ta', asset, 1, status, 'image/jpeg', 1000, 'image/jpeg', 1000, 1600, 900, :'sha', now(), now()
from media;
create function pg_temp.store(p_bucket text, p_names text[], p_files text[]) returns void
language sql as $$
  insert into storage.objects (bucket_id, name, metadata)
  select p_bucket, 'aaaaaaaa-0000-4000-8000-000000000001/' || m.asset || '/1/' || f, '{"size": 30000}'::jsonb
  from pg_temp.media m, unnest(p_files) f where m.name = any (p_names);
$$;
select pg_temp.store('media-originals', array['hero', 'old', 'private', 'half', 'logo', 'pano', 'gone'],
                     array['original', 'w480.webp', 'w960.webp', 'w1600.webp']);
select pg_temp.store('media-originals', array['hero', 'private', 'half'], array['hero-w800.webp', 'hero-w1200.webp']);
select pg_temp.store('media-public', array['hero', 'old', 'private', 'half'], array['w480.webp', 'w960.webp', 'w1600.webp']);
select pg_temp.store('media-public', array['hero'], array['hero-w800.webp', 'hero-w1200.webp']);
select pg_temp.store('media-public', array['half'], array['hero-w800.webp']);
grant select on media to rikuy_worker;

select plan(24);

-- ── The job kind ────────────────────────────────────────────────────────────
select is((select queue from public.job_kinds where kind = 'media.hero_images'), 'media',
  'the hero versions are a media job');
select ok(private.is_valid_job_payload('media.hero_images', jsonb_build_object('versionId', gen_random_uuid())),
  'its payload is the version');
select ok(not private.is_valid_job_payload('media.hero_images', '{"versionId": "x"}'::jsonb),
  'a payload that is not a version is refused');
select ok(not private.is_valid_job_payload('media.hero_images',
  jsonb_build_object('versionId', gen_random_uuid(), 'path', '../other')),
  'and so is anything more than the version');
select ok(private.is_valid_job_payload('reports.monthly', '{"month": "2026-10-01", "manual": false}'::jsonb),
  'the other kinds are still accepted');

-- ── What the portal reads ───────────────────────────────────────────────────
select is(private.public_image((select version_id from media where name = 'hero'), 'Foto') -> 'hero', 'true'::jsonb,
  'a photo with both hero versions public says so');
select ok(not (private.public_image((select version_id from media where name = 'old'), 'Foto') ? 'hero'),
  'a photo without them does not');
select ok(not (private.public_image((select version_id from media where name = 'private'), 'Foto') ? 'hero'),
  'nor one whose hero versions are only private: the portal never points to a missing file');
select ok(not (private.public_image((select version_id from media where name = 'half'), 'Foto') ? 'hero'),
  'nor one with only one of them public');
select is(private.public_image((select version_id from media where name = 'hero'), 'Foto') - 'hero',
  jsonb_build_object('assetId', (select asset from media where name = 'hero'), 'version', 1, 'alt', 'Foto',
                     'width', 1600, 'height', 900),
  'the rest of the image is what it was');
select ok(not has_function_privilege('anon', 'private.has_hero_images(text, uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.has_hero_images(text, uuid)', 'EXECUTE'),
  'visitors and users cannot ask Storage through it');

-- ── Photos uploaded before ──────────────────────────────────────────────────
select private.enqueue_hero_images();
select is(
  (select array_agg(subject_id) from public.background_jobs where tenant_id = :'ta' and kind = 'media.hero_images'),
  array[(select version_id from media where name = 'old')],
  'only the photo without them gets a job: not the ones that have them, the logo, the panorama nor the rejected');
select is(private.enqueue_hero_images(), 0, 'and only once');
-- Other tenants (the seed) out of the way.
update public.background_jobs set available_at = now() + interval '1 day'
where kind = 'media.hero_images' and tenant_id <> :'ta' and status = 'pending';

select ok(not has_function_privilege('authenticated', 'worker_api.hero_image_source(uuid, bigint)', 'EXECUTE')
          and not has_function_privilege('service_role', 'worker_api.hero_image_source(uuid, bigint)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'worker_api.complete_hero_images(uuid, bigint)', 'EXECUTE')
          and not has_function_privilege('anon', 'worker_api.complete_hero_images(uuid, bigint)', 'EXECUTE'),
  'only the runner reads and completes the job');

-- A job for the rejected photo too (as if it had been rejected after being enqueued).
select private.enqueue_job(:'ta', 'media.hero_images', 'manual:gone',
  jsonb_build_object('versionId', (select version_id from media where name = 'gone')),
  'asset_version', (select version_id from media where name = 'gone'));
select private.enqueue_job(:'ta', 'system.probe', 'probe:hero');

set local role rikuy_worker;
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 2, array['media.hero_images']);
create temp table c2 as select * from worker_api.claim_jobs('runner-a', 1, array['system.probe']);
reset role;
create temp table jobs as
select c.job_id, c.fencing_token, m.name
from c1 c join public.background_jobs j on j.id = c.job_id join media m on m.version_id = j.subject_id;
grant select on jobs to rikuy_worker;
select is((select count(*)::int from jobs), 2, 'the runner claims both');

set local role rikuy_worker;
select results_eq(
  format('select tenant_id, asset_id, version, original_path, published from worker_api.hero_image_source(%L, %s)',
         (select job_id from jobs where name = 'old'), (select fencing_token from jobs where name = 'old')),
  format('select %L::uuid, %L::uuid, 1, %L, true', :'ta', (select asset from media where name = 'old'),
         :'ta' || '/' || (select asset from media where name = 'old') || '/1/original'),
  'it reads where the original is and that the photo is public');
select is(worker_api.complete_hero_images((select job_id from jobs where name = 'old'), (select fencing_token from jobs where name = 'old')),
  'missing', 'it cannot complete before the files are stored');
select throws_ok(
  format('select * from worker_api.hero_image_source(%L, %s)', (select job_id from jobs where name = 'old'),
         (select fencing_token from jobs where name = 'old') + 1),
  'PT409', null, 'nor with another fencing token');
select throws_ok(
  format('select * from worker_api.hero_image_source(%L, %s)', (select job_id from c2), (select fencing_token from c2)),
  '23514', null, 'nor with a job of another kind');
select is(
  (select count(*)::int from worker_api.hero_image_source((select job_id from jobs where name = 'gone'),
                                                          (select fencing_token from jobs where name = 'gone'))),
  0, 'a rejected photo gives nothing to do');
select is(worker_api.complete_hero_images((select job_id from jobs where name = 'gone'), (select fencing_token from jobs where name = 'gone')),
  'gone', 'and completes as gone');
reset role;

select pg_temp.store('media-originals', array['old'], array['hero-w800.webp', 'hero-w1200.webp']);
set local role rikuy_worker;
select is(worker_api.complete_hero_images((select job_id from jobs where name = 'old'), (select fencing_token from jobs where name = 'old')),
  'done', 'once stored, it completes');
reset role;
select ok(not (private.public_image((select version_id from media where name = 'old'), 'Foto') ? 'hero'),
  'the portal still uses its regular versions until they are public');
select pg_temp.store('media-public', array['old'], array['hero-w800.webp', 'hero-w1200.webp']);
select is(private.public_image((select version_id from media where name = 'old'), 'Foto') -> 'hero', 'true'::jsonb,
  'and the hero versions once they are');

select * from finish();
rollback;
