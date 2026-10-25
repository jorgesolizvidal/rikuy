-- Quotas per municipality (P2 · Paso 5): defaults, atomic reservation on upload, settlement
-- from Storage and from the jobs' attempts, release on rejection, operator changes, isolation.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set op1 '00000000-0000-4000-8000-0000000000f1'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a1_aal2 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op_aal1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set mb 1048576

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test'),
  (:'op1', 'operator@example.test');
insert into public.platform_operators (user_id, status) values (:'op1', 'active');
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

create function pg_temp.usage(p_tenant uuid, p_resource text)
returns text language sql as $$
  select coalesce(
    (select b.consumed || '/' || b.reserved || '/' || b.limit_amount from public.usage_buckets b
     where b.tenant_id = p_tenant and b.resource = p_resource::public.usage_resource
     order by b.period_start desc limit 1),
    'none');
$$;

select plan(38);

-- ── Defaults and reading ───────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a4c';
select is(
  (select string_agg(resource || '=' || limit_amount || '/' || consumed, ' ' order by resource) from public.tenant_usage(:'ta')),
  'storage_bytes=314572800/0 media_compute_seconds=1800/0',
  'every municipality starts with 300 MB and 30 min per month, and an analyst can read them'
);
select is(
  (select to_char(period_start at time zone 'America/La_Paz', 'DD HH24:MI') from public.tenant_usage(:'ta') where resource = 'media_compute_seconds'),
  '01 00:00', 'the compute month starts at midnight of the 1st in the municipality''s time zone'
);
select is(
  (select period_end::text from public.tenant_usage(:'ta') where resource = 'storage_bytes'),
  'infinity', 'storage has no period'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.tenant_usage(%L)', :'ta'), '42501', null,
  'another municipality''s owner cannot read it'
);
select throws_ok('select * from public.usage_buckets', '42501', null, 'nobody reads the buckets directly');
select throws_ok('select * from public.tenant_quotas', '42501', null, 'nor the quotas');
reset role;
select ok(not has_function_privilege('anon', 'public.tenant_usage(uuid)', 'EXECUTE'), 'visitors cannot read usage');

-- ── Reservation on upload ──────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table photo as select * from public.create_image_upload(:'ta', 'content', 'image/jpeg', 10 * :mb);
create temp table pano as select * from public.create_image_upload(:'ta', 'panorama', 'image/jpeg', 50 * :mb);
grant select on photo, pano to rikuy_worker, service_role;
reset role;
select is(
  pg_temp.usage(:'ta', 'storage_bytes'),
  '0/' || (15 * :mb + 100 * :mb) || '/314572800',
  'uploads reserve ×1.5 for photos and ×2 for panoramas'
);
select is(pg_temp.usage(:'ta', 'media_compute_seconds'), '0/240/1800', 'a panorama also reserves 240 s of compute');

set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table big as select * from public.create_image_upload(:'ta', 'model', 'model/gltf-binary', 50 * :mb);
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'model', 'model/gltf-binary', 50 * :mb),
  'PT507', null, 'the next upload, which does not fit (215 + 100 > 300 MB), is refused'
);
select is(
  (select count(*)::int from public.list_tenant_models(:'ta')), 1, 'and nothing of it is created'
);
reset role;
select is(
  pg_temp.usage(:'ta', 'storage_bytes'), '0/' || (215 * :mb) || '/314572800',
  'the refused request reserved nothing'
);
-- The big one is abandoned: everything it reserved comes back.
update public.asset_versions set status = 'rejected', rejected_reason = 'abandoned'
where id = (select version_id from big);
set local role authenticated;
set local request.jwt.claims to :'b1c';
select lives_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'tb', 'model', 'model/gltf-binary', 50 * :mb),
  'another municipality has its own quota'
);
reset role;

-- ── Settlement: ready measures Storage; rejected releases ──────────────────
insert into storage.objects (bucket_id, name, metadata) values
  ('media-originals', (select original_path from photo), '{"size": 9000000}'),
  ('media-originals', replace((select original_path from photo), '/original', '/w480.webp'), '{"size": 40000}'),
  ('media-originals', replace((select original_path from photo), '/original', '/w960.webp'), '{"size": 120000}'),
  ('media-originals', (select original_path from pano), '{"size": 40000000}');
set local role service_role;
select public.media_complete_upload((select version_id from photo), 'image/jpeg', 9000000, 2000, 1500, :'sha');
reset role;
select is(
  pg_temp.usage(:'ta', 'storage_bytes'), '9160000/' || (100 * :mb) || '/314572800',
  'a ready photo counts its original and its derivatives, and frees the rest of its estimate'
);
insert into storage.objects (bucket_id, name, metadata) values
  ('media-public', replace((select original_path from photo), '/original', '/w480.webp'), '{"size": 40000}');
set local role service_role;
select public.media_publish_version(:'ta', (select asset_id from photo), 1);
reset role;
select is(
  split_part(pg_temp.usage(:'ta', 'storage_bytes'), '/', 1), '9200000',
  'publishing counts the public copies too'
);
set local role service_role;
select public.media_complete_upload((select version_id from photo), 'image/jpeg', 9000000, 2000, 1500, :'sha')
  where false; -- (completing twice is refused by the image path; settlement is idempotent anyway)
reset role;

-- The panorama: submitted, processed by the worker for 90 s, ready with renditions.
set local role authenticated;
set local request.jwt.claims to :'a3c';
select public.submit_panorama(:'ta', (select version_id from pano));
reset role;
set local role rikuy_worker;
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 1, array['media.process_panorama']);
reset role;
-- As if the attempt had run 90 s (start times are protected; paused only inside this test).
alter table public.job_attempts disable trigger job_attempts_protect;
update public.job_attempts set started_at = now() - interval '90 seconds' where job_id = (select job_id from c1);
alter table public.job_attempts enable trigger job_attempts_protect;
insert into storage.objects (bucket_id, name, metadata) values
  ('media-originals', replace((select original_path from pano), '/original', '/panorama/image.webp'), '{"size": 3000000}');
set local role rikuy_worker;
select worker_api.complete_panorama(
  (select job_id from c1), (select fencing_token from c1), 'image/jpeg', 40000000, 8192, 4096, :'sha',
  '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":40000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":1},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":3000000},"tiles":null}'
);
reset role;
select is(
  split_part(pg_temp.usage(:'ta', 'storage_bytes'), '/', 1), (9200000 + 43000000)::text,
  'a ready panorama counts its original and renditions'
);
select is(pg_temp.usage(:'ta', 'media_compute_seconds'), '0/240/1800', 'compute is settled when the job ends, not before');
set local role rikuy_worker;
select worker_api.complete_job((select job_id from c1), (select fencing_token from c1), '{"outcome":"ready"}', '{}');
reset role;
select ok(
  split_part(pg_temp.usage(:'ta', 'media_compute_seconds'), '/', 1)::int between 90 and 92
  and split_part(pg_temp.usage(:'ta', 'media_compute_seconds'), '/', 2) = '0',
  'the job''s 90 s are consumed and the estimate freed'
);

-- An upload abandoned before being submitted gives everything back.
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table gone as select * from public.create_image_upload(:'ta', 'model', 'model/gltf-binary', 10 * :mb);
reset role;
select is(
  split_part(pg_temp.usage(:'ta', 'media_compute_seconds'), '/', 2), '240', 'the model reserved its compute'
);
update public.asset_versions set status = 'rejected', rejected_reason = 'abandoned'
where id = (select version_id from gone);
select is(
  split_part(pg_temp.usage(:'ta', 'storage_bytes'), '/', 2) || ' ' || split_part(pg_temp.usage(:'ta', 'media_compute_seconds'), '/', 2),
  '0 0', 'a rejected upload with no job releases both reservations'
);
select is(
  (select status || ' ' || consumed from public.usage_reservations where asset_version_id = (select version_id from gone) and resource = 'storage_bytes'),
  'released 0', 'and keeps no storage'
);

-- A panorama rejected by the worker: storage released, the compute it used is still counted.
set local role authenticated;
set local request.jwt.claims to :'a1c';
create temp table bad as select * from public.create_image_upload(:'ta', 'panorama', 'image/jpeg', 5 * :mb);
reset role;
insert into storage.objects (bucket_id, name, metadata) values ('media-originals', (select original_path from bad), '{"size": 5000000}');
set local role authenticated;
set local request.jwt.claims to :'a1c';
select public.submit_panorama(:'ta', (select version_id from bad));
reset role;
set local role rikuy_worker;
create temp table c2 as select * from worker_api.claim_jobs('runner-b', 1, array['media.process_panorama']);
reset role;
-- As if the attempt had run 30 s (start times are protected; paused only inside this test).
alter table public.job_attempts disable trigger job_attempts_protect;
update public.job_attempts set started_at = now() - interval '30 seconds' where job_id = (select job_id from c2);
alter table public.job_attempts enable trigger job_attempts_protect;
set local role rikuy_worker;
select worker_api.reject_panorama((select job_id from c2), (select fencing_token from c2), 'not_equirectangular');
select worker_api.complete_job((select job_id from c2), (select fencing_token from c2), '{"outcome":"rejected"}', '{}');
reset role;
select is(
  (select r.status || ' ' || r.consumed from public.usage_reservations r where r.asset_version_id = (select version_id from bad) and r.resource = 'storage_bytes'),
  'released 0', 'a rejected panorama keeps no storage'
);
select ok(
  (select r.consumed between 30 and 32 from public.usage_reservations r where r.asset_version_id = (select version_id from bad) and r.resource = 'media_compute_seconds'),
  'but the time it was processed is counted'
);

-- ── The operator ───────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1_aal2';
select throws_ok(
  format('select public.platform_set_quota(%L, %L, %s)', :'ta', 'storage_bytes', 1000), '42501', null,
  'an owner cannot change their own quota'
);
select throws_ok('select * from public.platform_tenant_usage()', '42501', null, 'nor see other municipalities''');
set local request.jwt.claims to :'op_aal1';
select throws_ok(
  format('select public.platform_set_quota(%L, %L, %s)', :'ta', 'storage_bytes', 1000), '42501', null,
  'an operator needs the second factor'
);
set local request.jwt.claims to :'op_aal2';
select throws_ok(
  format('select public.platform_set_quota(%L, %L, %s)', :'ta', 'storage_bytes', -1), '23514', null,
  'a negative limit is refused'
);
select lives_ok(
  format('select public.platform_set_quota(%L, %L, %s)', :'ta', 'storage_bytes', 50 * :mb),
  'the operator lowers it below what is used'
);
select is(
  (select limit_amount || ' ' || is_default from public.platform_tenant_usage() where tenant_id = :'ta' and resource = 'storage_bytes'),
  (50 * :mb) || ' false', 'the operator sees the new limit, marked as assigned'
);
select is(
  (select limit_amount::text from public.platform_tenant_usage() where tenant_id = :'tb' and resource = 'storage_bytes'),
  '314572800', 'other municipalities keep theirs'
);
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'content', 'image/jpeg', 1000000),
  'PT507', null, 'nothing more is uploaded until there is room'
);
select is(
  (select consumed::text from public.tenant_usage(:'ta') where resource = 'storage_bytes'),
  (9200000 + 43000000)::text, 'and nothing was deleted'
);
set local request.jwt.claims to :'op_aal2';
select lives_ok(
  format('select public.platform_set_quota(%L, %L, %s)', :'ta', 'storage_bytes', 500 * :mb),
  'the operator raises it again'
);
set local request.jwt.claims to :'a3c';
select lives_ok(
  format('select * from public.create_image_upload(%L, %L, %L, %s)', :'ta', 'content', 'image/jpeg', 1000000),
  'and uploads work again'
);
reset role;
select is(
  (select count(*)::int from public.audit_events where action = 'platform.quota_changed' and tenant_id = :'ta'),
  2, 'every change is audited'
);
select is(
  (select diff ->> 'from' || '→' || (diff ->> 'to') from public.audit_events
   where action = 'platform.quota_changed' and (diff ->> 'to')::bigint = 50 * :mb),
  '314572800→' || (50 * :mb), 'with the previous and the new limit'
);

-- ── Privileges ──────────────────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'private.reserve_usage(uuid, public.usage_resource, uuid, bigint)', 'EXECUTE'), 'people cannot reserve directly');
select ok(not has_function_privilege('rikuy_worker', 'private.settle_usage(public.usage_resource, uuid, bigint, text)', 'EXECUTE'), 'nor can the worker settle directly');

select * from finish();
rollback;
