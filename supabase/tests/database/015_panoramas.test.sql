-- Panorama pipeline (P2 · Paso 3): upload limits, submission → durable job, the worker's
-- lease-bound pipeline functions and the manifest.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set manifest '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":{"tileSize":512,"format":"webp","levels":[{"width":2048,"height":1024,"cols":4,"rows":2,"dir":"tiles/0"}]}}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

select plan(35);

-- ── Limits ──────────────────────────────────────────────────────────────────
select is(
  (select file_size_limit from storage.buckets where id = 'media-originals'), 52428800::bigint,
  'originals accept up to 50 MB'
);
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table up1 as select * from public.create_image_upload(:'ta', 'panorama', 'image/jpeg', 50000000);
create temp table up2 as select * from public.create_image_upload(:'ta', 'panorama', 'image/jpeg', 30000000);
create temp table img as select * from public.create_image_upload(:'ta', 'content', 'image/jpeg', 1000);
grant select on up1, up2, img to rikuy_worker;
select ok((select version_id from up1) is not null, 'an editor reserves a 50 MB panorama');
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'panorama', 'image/jpeg', 60000000),
  '23514', null, 'a panorama above 50 MB is refused'
);
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'content', 'image/jpeg', 20000000),
  '23514', null, 'photos keep their 10 MB limit'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'panorama', 'image/jpeg', 1000),
  '42501', null, 'an analyst cannot upload panoramas'
);

-- ── Submission ──────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select public.submit_panorama(%L, %L)', :'ta', (select version_id from up1)),
  'PT409', null, 'nothing is processed before the original is uploaded'
);
reset role;
insert into storage.objects (bucket_id, name) values
  ('media-originals', (select original_path from up1)),
  ('media-originals', (select original_path from up2)),
  ('media-originals', (select original_path from img));
set local role authenticated;
set local request.jwt.claims to :'a3c';
select is(public.submit_panorama(:'ta', (select version_id from up1)), 'processing', 'submitting moves it to processing');
select is(public.submit_panorama(:'ta', (select version_id from up1)), 'processing', 'submitting twice is harmless');
select throws_ok(
  format('select public.submit_panorama(%L, %L)', :'ta', (select version_id from img)),
  'PT404', null, 'a photo is not a panorama'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select public.submit_panorama(%L, %L)', :'ta', (select version_id from up2)),
  '42501', null, 'an analyst cannot submit'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select public.submit_panorama(%L, %L)', :'tb', (select version_id from up2)),
  'PT404', null, 'another tenant''s owner cannot submit it under their tenant'
);
select throws_ok(
  format('select public.submit_panorama(%L, %L)', :'ta', (select version_id from up2)),
  '42501', null, 'nor under the panorama''s tenant'
);
select throws_ok(
  format('select * from public.list_tenant_panoramas(%L)', :'ta'),
  '42501', null, 'nor list its panoramas'
);
set local request.jwt.claims to :'a4c';
select is(
  (select job_status::text || ' ' || status::text from public.list_tenant_panoramas(:'ta') where version_id = (select version_id from up1)),
  'pending processing', 'an analyst sees the panorama processing, with its job'
);
reset role;

select is(
  (select count(*)::int from public.background_jobs
   where kind = 'media.process_panorama' and subject_id = (select version_id from up1)),
  1, 'one job per panorama'
);
select is(
  (select count(*)::int from public.audit_events where action = 'media.panorama_submitted'), 1,
  'the submission is audited'
);
select throws_ok(
  format('update public.asset_versions set manifest = %L where id = %L', :'manifest', (select version_id from up1)),
  '23514', null, 'only a ready version holds a manifest'
);

-- ── The worker: complete ───────────────────────────────────────────────────
set local role rikuy_worker;
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 1, array['media.process_panorama']);
create temp table s1 as select * from worker_api.panorama_source((select job_id from c1), (select fencing_token from c1));
select is((select status from s1), 'processing', 'the worker reads the source of its job');
select is((select original_path from s1), (select original_path from up1), 'with its original');
select is(
  (select prefix from s1),
  :'ta' || '/' || (select asset_id from up1)::text || '/1/', 'and the folder of its renditions'
);
select throws_ok(
  format('select worker_api.complete_panorama(%L, %s, %L, 9000000, 8192, 4096, %L, %L)',
    (select job_id from c1), (select fencing_token from c1), 'image/jpeg', :'sha', '{"version":1,"projection":"equirectangular","image":{"file":"../x"}}'),
  '23514', null, 'a malformed manifest is refused'
);
select throws_ok(
  format('select worker_api.complete_panorama(%L, %s, %L, 9000000, 8192, 4096, %L, %L)',
    (select job_id from c1), (select fencing_token from c1) + 99, 'image/jpeg', :'sha', :'manifest'),
  'PT409', null, 'without the current token nothing is written'
);
select is(
  worker_api.complete_panorama((select job_id from c1), (select fencing_token from c1), 'image/jpeg', 9000000, 8192, 4096, :'sha', :'manifest'),
  'ready', 'the pipeline completes the panorama'
);
select is(
  worker_api.complete_panorama((select job_id from c1), (select fencing_token from c1), 'image/jpeg', 9000000, 8192, 4096, :'sha', :'manifest'),
  'already_settled', 'completing again changes nothing'
);
select worker_api.complete_job((select job_id from c1), (select fencing_token from c1), '{"outcome":"ready"}', '{}');
reset role;
select is(
  (select status::text || ' ' || width || 'x' || height || ' ' || (manifest -> 'tiles' -> 'levels' -> 0 ->> 'dir')
   from public.asset_versions where id = (select version_id from up1)),
  'ready 8192x4096 tiles/0', 'the version is ready with its manifest'
);
select is(
  (select count(*)::int from public.audit_events where action = 'media.panorama_ready'), 1, 'and it is audited'
);

-- ── The worker: reject ─────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is(public.submit_panorama(:'ta', (select version_id from up2)), 'processing', 'the owner submits another');
reset role;
set local role rikuy_worker;
create temp table c2 as select * from worker_api.claim_jobs('runner-b', 1, array['media.process_panorama']);
select throws_ok(
  format('select worker_api.reject_panorama(%L, %s, %L)', (select job_id from c2), (select fencing_token from c2), '  '),
  '23514', null, 'a rejection needs a reason'
);
select is(
  worker_api.reject_panorama((select job_id from c2), (select fencing_token from c2), 'not_equirectangular'),
  'rejected', 'a 4:3 photo is rejected'
);
reset role;
select is(
  (select status::text || ': ' || rejected_reason from public.asset_versions where id = (select version_id from up2)),
  'rejected: not_equirectangular', 'with its reason'
);

-- A probe's lease cannot touch panoramas.
select private.enqueue_job(:'ta', 'system.probe', 'probe:panorama-test');
set local role rikuy_worker;
create temp table c4 as select * from worker_api.claim_jobs('runner-d', 1, array['system.probe']);
select throws_ok(
  format('select * from worker_api.panorama_source(%L, %s)', (select job_id from c4), (select fencing_token from c4)),
  '23514', null, 'a probe''s lease cannot read panoramas'
);
reset role;

-- ── Privileges ──────────────────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'worker_api.complete_panorama(uuid, bigint, text, integer, integer, integer, text, jsonb)', 'EXECUTE'), 'users cannot complete panoramas');
select ok(not has_function_privilege('service_role', 'worker_api.reject_panorama(uuid, bigint, text)', 'EXECUTE'), 'the service role cannot reject them through worker_api');
select ok(not has_function_privilege('anon', 'public.submit_panorama(uuid, uuid)', 'EXECUTE'), 'visitors cannot submit panoramas');
select ok(not has_function_privilege('anon', 'public.list_tenant_panoramas(uuid)', 'EXECUTE'), 'visitors cannot list them');

select * from finish();
rollback;
