-- GLB pipeline (P2 · Paso 4): upload type and limits, submission → durable job, the worker's
-- lease-bound pipeline functions, the manifest and the poster.
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
\set manifest '{"version":1,"format":"glb","source":{"bytes":482828,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","triangles":15177,"vertices":4612,"materials":4,"textures":11,"generator":"Blender","extensions":["KHR_draco_mesh_compression"]},"model":{"file":"model.glb","bytes":1250000,"triangles":15177,"geometry":"meshopt","textures":[{"name":"base","usage":"color","width":1024,"height":1024,"encoding":"etc1s","bytes":39437,"check":{"mean":1.45,"p95":2.21}}]},"colors":{"materials":"unchanged","vertexColors":null,"suspects":[{"material":"Dorado","texture":"MNegro_metallicRoughness"}]},"weight":"light","poster":null}'
\set poster '{"file":"poster.webp","width":1280,"height":960,"bytes":90000}'
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

select plan(45);

-- ── Upload type and limits ──────────────────────────────────────────────────
select ok(
  (select 'model/gltf-binary' = any(allowed_mime_types) and 'image/ktx2' = any(allowed_mime_types)
   from storage.buckets where id = 'media-originals'),
  'the private bucket accepts GLB files and the KTX2 textures of the pipeline'
);
select ok(
  (select 'model/gltf-binary' = any(allowed_mime_types) from storage.buckets where id = 'media-public'),
  'only the public bucket for published tours accepts GLB files besides the originals (P4 · Paso 3)'
);
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table m1 as select * from public.create_image_upload(:'ta', 'model', 'model/gltf-binary', 50000000);
create temp table m2 as select * from public.create_image_upload(:'ta', 'model', 'model/gltf-binary', 3000000);
create temp table ph as select * from public.create_image_upload(:'ta', 'content', 'image/jpeg', 1000);
grant select on m1, m2, ph to rikuy_worker;
select ok((select version_id from m1) is not null, 'an editor reserves a 50 MB model');
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'model', 'model/gltf-binary', 60000000),
  '23514', null, 'a model above 50 MB is refused'
);
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'model', 'image/png', 1000),
  '23514', null, 'a model must be declared as GLB'
);
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'content', 'model/gltf-binary', 1000),
  '23514', null, 'a photo cannot be declared as GLB'
);
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'content', 'image/svg+xml', 1000),
  '23514', null, 'images keep their types'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'model', 'model/gltf-binary', 1000),
  '42501', null, 'an analyst cannot upload models'
);
reset role;

-- The synchronous image path never completes a model.
select throws_ok(
  format('select public.media_complete_upload(%L, %L, 1000, 100, 100, %L)', (select version_id from m2), 'image/png', :'sha'),
  'PT409', null, 'the image path cannot turn a model into an image'
);

-- ── Submission ──────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select public.submit_model(%L, %L)', :'ta', (select version_id from m1)),
  'PT409', null, 'nothing is processed before the original is uploaded'
);
reset role;
insert into storage.objects (bucket_id, name) values
  ('media-originals', (select original_path from m1)),
  ('media-originals', (select original_path from m2)),
  ('media-originals', (select original_path from ph));
set local role authenticated;
set local request.jwt.claims to :'a3c';
select is(public.submit_model(:'ta', (select version_id from m1)), 'processing', 'submitting moves it to processing');
select is(public.submit_model(:'ta', (select version_id from m1)), 'processing', 'submitting twice is harmless');
select throws_ok(
  format('select public.submit_model(%L, %L)', :'ta', (select version_id from ph)),
  'PT404', null, 'a photo is not a model'
);
select throws_ok(
  format('select public.submit_panorama(%L, %L)', :'ta', (select version_id from m2)),
  'PT404', null, 'nor is a model a panorama'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select public.submit_model(%L, %L)', :'ta', (select version_id from m2)),
  '42501', null, 'an analyst cannot submit'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select public.submit_model(%L, %L)', :'tb', (select version_id from m2)),
  'PT404', null, 'another tenant''s owner cannot submit it under their tenant'
);
select throws_ok(
  format('select public.submit_model(%L, %L)', :'ta', (select version_id from m2)),
  '42501', null, 'nor under the model''s tenant'
);
select throws_ok(
  format('select * from public.list_tenant_models(%L)', :'ta'),
  '42501', null, 'nor list its models'
);
set local request.jwt.claims to :'a4c';
select is(
  (select job_status::text || ' ' || status::text from public.list_tenant_models(:'ta') where version_id = (select version_id from m1)),
  'pending processing', 'an analyst sees the model processing, with its job'
);
select is(
  (select count(*)::int from public.list_tenant_models(:'ta') where version_id = (select version_id from ph)),
  0, 'photos are not listed as models'
);
reset role;

select is(
  (select count(*)::int from public.background_jobs
   where kind = 'media.process_model' and subject_id = (select version_id from m1)),
  1, 'one job per model'
);
select is(
  (select count(*)::int from public.audit_events where action = 'media.model_submitted'), 1,
  'the submission is audited'
);

-- ── The worker: complete ───────────────────────────────────────────────────
set local role rikuy_worker;
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 1, array['media.process_model']);
create temp table s1 as select * from worker_api.model_source((select job_id from c1), (select fencing_token from c1));
select is((select status from s1), 'processing', 'the worker reads the source of its job');
select is(
  (select original_path || ' ' || declared_mime from s1),
  (select original_path from m1) || ' model/gltf-binary', 'with its original'
);
select is(
  (select prefix from s1),
  :'ta' || '/' || (select asset_id from m1)::text || '/1/', 'and the folder of what it makes'
);
select throws_ok(
  format('select worker_api.complete_model(%L, %s, 482828, %L, %L)',
    (select job_id from c1), (select fencing_token from c1), :'sha', jsonb_set(:'manifest'::jsonb, '{model,bytes}', '20000000')),
  '23514', null, 'an optimized model above 15 MB is refused'
);
select throws_ok(
  format('select worker_api.complete_model(%L, %s, 482828, %L, %L)',
    (select job_id from c1), (select fencing_token from c1), :'sha', jsonb_set(:'manifest'::jsonb, '{model,file}', '"../x.glb"')),
  '23514', null, 'a file outside the version folder is refused'
);
select throws_ok(
  format('select worker_api.complete_model(%L, %s, 482828, %L, %L)',
    (select job_id from c1), (select fencing_token from c1), :'sha', jsonb_set(:'manifest'::jsonb, '{poster}', :'poster')),
  '23514', null, 'the pipeline cannot set a poster'
);
select throws_ok(
  format('select worker_api.complete_model(%L, %s, 482828, %L, %L)',
    (select job_id from c1), (select fencing_token from c1) + 99, :'sha', :'manifest'),
  'PT409', null, 'without the current token nothing is written'
);
select is(
  worker_api.complete_model((select job_id from c1), (select fencing_token from c1), 482828, :'sha', :'manifest'),
  'ready', 'the pipeline completes the model'
);
select is(
  worker_api.complete_model((select job_id from c1), (select fencing_token from c1), 482828, :'sha', :'manifest'),
  'already_settled', 'completing again changes nothing'
);
select worker_api.complete_job((select job_id from c1), (select fencing_token from c1), '{"outcome":"ready"}', '{}');
reset role;
select is(
  (select status::text || ' ' || mime || ' ' || bytes || ' ' || coalesce(width::text, 'no size') || ' ' || (manifest -> 'model' ->> 'file')
   from public.asset_versions where id = (select version_id from m1)),
  'ready model/gltf-binary 482828 no size model.glb', 'the version is ready with its manifest'
);
select is(
  (select (diff ->> 'suspects')::int from public.audit_events where action = 'media.model_ready'), 1,
  'it is audited, with the colors to review'
);

-- ── The poster ──────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select public.set_model_poster(%L, %L, %L)', :'ta', (select version_id from m1), :'poster'),
  '42501', null, 'an analyst cannot set the poster'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select public.set_model_poster(%L, %L, %L)', :'tb', (select version_id from m1), :'poster'),
  'PT404', null, 'another tenant cannot set it'
);
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select public.set_model_poster(%L, %L, %L)', :'ta', (select version_id from m1), '{"file":"../x.webp","width":1280,"height":960,"bytes":1}'),
  '23514', null, 'a poster outside the version folder is refused'
);
select throws_ok(
  format('select public.set_model_poster(%L, %L, %L)', :'ta', (select version_id from m2), :'poster'),
  'PT409', null, 'a model that is not ready has no poster'
);
select lives_ok(
  format('select public.set_model_poster(%L, %L, %L)', :'ta', (select version_id from m1), :'poster'),
  'an editor sets the captured poster'
);
reset role;
select is(
  (select manifest -> 'poster' ->> 'width' from public.asset_versions where id = (select version_id from m1)),
  '1280', 'the manifest keeps the poster'
);

-- ── The worker: reject ─────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is(public.submit_model(:'ta', (select version_id from m2)), 'processing', 'the owner submits another');
reset role;
set local role rikuy_worker;
create temp table c2 as select * from worker_api.claim_jobs('runner-b', 1, array['media.process_model']);
select is(
  worker_api.reject_model((select job_id from c2), (select fencing_token from c2), 'external_files'),
  'rejected', 'a GLB that points to external files is rejected'
);
reset role;
select is(
  (select status::text || ': ' || rejected_reason from public.asset_versions where id = (select version_id from m2)),
  'rejected: external_files', 'with its reason'
);

-- A probe's lease cannot touch models.
select private.enqueue_job(:'ta', 'system.probe', 'probe:model-test');
set local role rikuy_worker;
create temp table c4 as select * from worker_api.claim_jobs('runner-d', 1, array['system.probe']);
select throws_ok(
  format('select * from worker_api.model_source(%L, %s)', (select job_id from c4), (select fencing_token from c4)),
  '23514', null, 'a probe''s lease cannot read models'
);
reset role;

-- ── Privileges ──────────────────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'worker_api.complete_model(uuid, bigint, integer, text, jsonb)', 'EXECUTE'), 'users cannot complete models');
select ok(not has_function_privilege('anon', 'public.set_model_poster(uuid, uuid, jsonb)', 'EXECUTE'), 'visitors cannot set posters');

select * from finish();
rollback;
