-- ★ Hito · Paso 3 (ADR-035): the operations snapshot, the daily report and the removal of
-- unused photos and logos.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set op1 '00000000-0000-4000-8000-0000000000f1'
\set a1  '00000000-0000-4000-8000-0000000000a1'
\set ta  'aaaaaaaa-0000-4000-8000-000000000001'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op_aal1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set brand '{"identity":{"siteName":"Tenant A","shortName":"A","tagline":""},"theme":{"mode":"light","brand":"#1e3a8a","accent":"#b45309"},"contact":{},"social":[],"seo":{"description":""}}'

insert into auth.users (id, email) values (:'op1', 'operador@example.test'), (:'a1', 'owner.a@example.test');
insert into public.platform_operators (user_id, status) values (:'op1', 'active');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;
grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

-- Five ready images: an old unused photo, a photo a draft uses, a logo a brand version
-- uses, a fresh unused photo and an old unused panorama.
create temp table media (name text primary key, purpose public.asset_purpose, ready interval,
                         asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, purpose, ready) values
  ('old', 'content', '8 days'), ('used', 'content', '8 days'), ('logo', 'logo', '30 days'),
  ('fresh', 'content', '1 day'), ('pano', 'panorama', '60 days');
insert into public.assets (id, tenant_id, purpose) select asset, :'ta', purpose from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                   mime, bytes, width, height, sha256, ready_at)
select version_id, :'ta', asset, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 2048, 1024, :'sha', now() - ready
from media;
insert into storage.objects (bucket_id, name, metadata)
select 'media-originals', :'ta' || '/' || asset || '/1/' || f, '{"size": 40000}'::jsonb
from media, unnest(array['original', 'w480.webp']) f;
insert into public.tenant_config_versions (tenant_id, version, state, branding)
select :'ta', 1, 'draft', :'brand'::jsonb || jsonb_build_object('logo', jsonb_build_object('assetId', asset, 'version', 1))
from media where name = 'logo';
grant select on media to authenticated, rikuy_worker;

select plan(28);

set local role authenticated;
set local request.jwt.claims to :'a1c';
select content_id as dest from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza') \gset
select lives_ok(format('select * from public.save_content_draft(%L, %L, %L::jsonb, 1)', :'ta', :'dest',
  jsonb_build_object('title', 'Plaza', 'summary', '', 'body', '[]'::jsonb, 'location', null, 'gallery', '[]'::jsonb,
    'cover', jsonb_build_object('assetId', (select asset from media where name = 'used'), 'version', 1, 'alt', 'La plaza'))),
  'a draft uses one of the photos');
reset role;

-- ── The snapshot ────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select ok((select public.platform_operations() ?& array['storage', 'database', 'jobs', 'quotas', 'unusedMedia']),
  'an operator reads the operations snapshot');
select is((select (public.platform_operations() #>> '{storage,limit}')::bigint), 1073741824::bigint,
  'with the free plan''s 1 GB of Storage');
select is((select (public.platform_operations() #>> '{storage,bytes}')::bigint), 400000::bigint,
  'and what the whole project stores');
select ok((select (public.platform_operations() #>> '{database,bytes}')::bigint > 0), 'and the database size');
select ok(not (public.platform_operations() ? 'operators'), 'without the operators'' addresses');
set local request.jwt.claims to :'op_aal1';
select throws_ok('select public.platform_operations()', '42501', null, 'not without the second factor');
set local request.jwt.claims to :'a1c';
select throws_ok('select public.platform_operations()', '42501', null, 'nor for a municipality''s owner');
select throws_ok('select worker_api.operations_report()', '42501', null, 'who cannot read the runner''s report either');
reset role;
set local role anon;
select throws_ok('select public.platform_operations()', '42501', null, 'nor for visitors');
reset role;

-- Failed jobs, waiting work and quotas close to their limit show up.
create temp table failed_before as select (private.operations_snapshot() #>> '{jobs,failed24h}')::int as n;
select private.enqueue_job(:'ta', 'system.probe', 'probe:failed');
update public.background_jobs set status = 'dead_letter', finished_at = now() where logical_key = 'probe:failed';
select private.enqueue_job(:'ta', 'system.probe', 'probe:waiting');
update public.background_jobs set available_at = now() - interval '20 minutes' where logical_key = 'probe:waiting';
insert into public.usage_buckets (tenant_id, resource, period_start, period_end, limit_amount, consumed)
select :'ta', 'storage_bytes', p.period_start, p.period_end, 100000, 90000
from private.usage_period(:'ta', 'storage_bytes') p
on conflict (tenant_id, resource, period_start) do update set limit_amount = 100000, consumed = 90000, reserved = 0;
set local role rikuy_worker;
create temp table report as select worker_api.operations_report() as r;
reset role;
select is((select (r #>> '{jobs,failed24h}')::int from report), (select n + 1 from failed_before), 'the report counts the jobs that failed today');
select ok((select (r #>> '{jobs,waitingSeconds}')::int >= 1200 from report), 'and how long work has been waiting');
select is((select r -> 'quotas' -> 0 ->> 'slug' from report), 'tenant-a', 'and the municipalities at 80 % of a quota');
select ok((select r -> 'operators' from report) @> '["operador@example.test"]'::jsonb, 'and whom to tell');
update public.background_jobs set status = 'succeeded', finished_at = now() where logical_key = 'probe:waiting';

-- ── The daily report request ────────────────────────────────────────────────
delete from net.http_request_queue;
select ok(not private.request_daily_report(), 'without the runner configured, nothing is requested');
select vault.create_secret('https://runner.example.test/api/jobs/drain', 'rikuy_job_runner_url');
select vault.create_secret('local-test-runner-secret-0123456789abcdef', 'rikuy_job_runner_secret');
select ok(private.request_daily_report(), 'configured, the database asks for the report');
select is((select convert_from(body, 'UTF8')::jsonb ->> 'reason' from net.http_request_queue), 'daily', 'as a daily request with the runner''s secret');
select is((select schedule from cron.job where jobname = 'rikuy-daily-report'), '7 11 * * *', 'every day at 07:07 in Bolivia');
select is((select schedule from cron.job where jobname = 'rikuy-remove-unused-media'), '37 7 * * *', 'and the sweep at 03:37');

-- ── Unused photos and logos ─────────────────────────────────────────────────
select is(private.enqueue_unused_media_jobs(), 1, 'the sweep finds one unused image');
select is((select subject_id from public.background_jobs where kind = 'media.remove_unused'),
  (select version_id from media where name = 'old'),
  'the old unused photo: not the used one, the brand''s logo, the fresh one nor the panorama');
select is(private.enqueue_unused_media_jobs(), 0, 'and finds it only once');

set local role rikuy_worker;
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 5, array['media.remove_unused']);
select is(worker_api.claim_unused_media((select job_id from c1), (select fencing_token from c1)),
  :'ta' || '/' || (select asset from media where name = 'old') || '/1/', 'the runner gets the folder to remove');
select is(worker_api.claim_unused_media((select job_id from c1), (select fencing_token from c1)),
  :'ta' || '/' || (select asset from media where name = 'old') || '/1/', 'again on a retry (removing is idempotent)');
reset role;
select is((select status::text || ': ' || rejected_reason from public.asset_versions where id = (select version_id from media where name = 'old')),
  'rejected: Sin uso: se liberó su espacio.', 'the version is rejected first, so nothing can start using it');
select is((select (diff ->> 'bytes')::int from public.audit_events where action = 'media.unused_removed'), 80000,
  'and the removal is audited with the space it frees');

-- A version that is used again by the time the job runs is left alone.
select private.enqueue_job(:'ta', 'media.remove_unused', 'manual:used',
  jsonb_build_object('versionId', (select version_id from media where name = 'used')),
  'asset_version', (select version_id from media where name = 'used'));
set local role rikuy_worker;
create temp table c2 as select * from worker_api.claim_jobs('runner-b', 5, array['media.remove_unused']);
select is(worker_api.claim_unused_media((select job_id from c2), (select fencing_token from c2)), null,
  'a photo a draft uses is never removed');
reset role;
select is((select status::text from public.asset_versions where id = (select version_id from media where name = 'used')),
  'ready', 'and stays ready');

select * from finish();
rollback;
