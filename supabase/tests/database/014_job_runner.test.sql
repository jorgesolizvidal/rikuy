-- Waking the job runner (P2 · Paso 2) and the first real job: expiring abandoned uploads.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set a1 '00000000-0000-4000-8000-0000000000a1'
\set b1 '00000000-0000-4000-8000-0000000000b1'
\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set asset 'aaaaaaaa-0000-4000-8000-0000000000a5'
\set vold 'aaaaaaaa-0000-4000-8000-0000000000f1'
\set vnew 'aaaaaaaa-0000-4000-8000-0000000000f2'
\set vrej 'aaaaaaaa-0000-4000-8000-0000000000f3'

insert into auth.users (id, email) values (:'a1', 'owner.a@example.test'), (:'b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now()), (:'tb', :'b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

insert into public.assets (id, tenant_id, purpose) values (:'asset', :'ta', 'content');
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, created_at, rejected_reason) values
  (:'vold', :'ta', :'asset', 1, 'uploading', 'image/png', 1000, now() - interval '2 days', null),
  (:'vnew', :'ta', :'asset', 2, 'uploading', 'image/png', 1000, now() - interval '1 hour', null),
  (:'vrej', :'ta', :'asset', 3, 'rejected', 'image/png', 1000, now() - interval '3 days', 'not an image');

-- The seed's probes are finished (they never wake anyone); start from an empty request queue.
delete from net.http_request_queue;
delete from private.job_runner_kicks;

grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

select plan(30);

-- ── Privileges and schedules ────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'private.kick_job_runner(text)', 'EXECUTE'), 'users cannot wake the runner');
select ok(not has_function_privilege('rikuy_worker', 'private.kick_job_runner(text)', 'EXECUTE'), 'the worker cannot either');
select ok(not has_function_privilege('rikuy_worker', 'private.enqueue_abandoned_upload_jobs(integer)', 'EXECUTE'), 'the worker cannot enqueue the sweep');
select ok(has_function_privilege('rikuy_worker', 'worker_api.abandoned_upload(uuid, bigint)', 'EXECUTE'), 'the worker inspects an abandoned upload');
select ok(not has_function_privilege('service_role', 'worker_api.mark_upload_abandoned(uuid, bigint)', 'EXECUTE'), 'the service role cannot mark uploads through worker_api');
select is(
  (select schedule from cron.job where jobname = 'rikuy-job-runner'), '* * * * *',
  'the safety-net kick runs every minute'
);
select is(
  (select schedule from cron.job where jobname = 'rikuy-expire-abandoned-uploads'), '17 7 * * *',
  'the abandoned-upload sweep runs daily'
);

-- ── Without configuration nothing is called ────────────────────────────────
select private.enqueue_job(:'ta', 'system.probe', 'probe:unconfigured');
select is((select count(*)::int from net.http_request_queue), 0, 'without the Vault settings an enqueue calls nobody');
select ok(not private.kick_job_runner('schedule'), 'and the schedule calls nobody either');
select throws_ok($$select private.kick_job_runner('anything')$$, '23514', null, 'the kick reason is validated');

-- ── The sweep ───────────────────────────────────────────────────────────────
select is(private.enqueue_abandoned_upload_jobs(), 1, 'only the version uploading for more than 24 h is swept');
select is(private.enqueue_abandoned_upload_jobs(), 0, 'running the sweep again creates nothing');
select is(
  (select payload from public.background_jobs where kind = 'media.expire_abandoned_upload'),
  jsonb_build_object('versionId', :'vold'::uuid), 'the job names the version'
);
select is(
  (select subject_id from public.background_jobs where kind = 'media.expire_abandoned_upload'),
  :'vold'::uuid, 'and the version is its subject'
);
select throws_ok(
  format('select private.enqueue_job(%L, %L, %L, %L)', :'ta', 'media.expire_abandoned_upload', 'x', '{"versionId":"nope"}'),
  '23514', null, 'an invalid payload is refused'
);

-- ── The runner expires it ──────────────────────────────────────────────────
set local role rikuy_worker;
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 1, array['media.expire_abandoned_upload']);
create temp table found1 as select * from worker_api.abandoned_upload((select job_id from c1), (select fencing_token from c1));
select ok((select abandoned from found1), 'the upload is still abandoned');
select is(
  (select original_path from found1), :'ta' || '/' || :'asset' || '/1/original',
  'and the runner learns where its original would be'
);
select is(worker_api.mark_upload_abandoned((select job_id from c1), (select fencing_token from c1)), 'marked', 'the version is marked');
select is(worker_api.mark_upload_abandoned((select job_id from c1), (select fencing_token from c1)), 'already_settled', 'marking again changes nothing');
select throws_ok(
  format('select * from worker_api.abandoned_upload(%L, %s)', (select job_id from c1), (select fencing_token from c1) + 99),
  'PT409', null, 'without the current token nothing is read'
);
reset role;

select is(
  (select status::text || ': ' || rejected_reason from public.asset_versions where id = :'vold'),
  'rejected: Subida abandonada: nunca se confirmó.', 'the abandoned version is rejected'
);
select is((select status::text from public.asset_versions where id = :'vnew'), 'uploading', 'a recent upload is untouched');
select is(
  (select count(*)::int from public.audit_events where action = 'media.upload_abandoned' and entity_id = :'vold'),
  1, 'and it is audited once'
);

-- A job of tenant B naming a version of tenant A learns nothing about it.
select private.enqueue_job(:'tb', 'media.expire_abandoned_upload', 'asset_version:cross',
  jsonb_build_object('versionId', :'vnew'::uuid), 'asset_version', :'vnew');
update public.asset_versions set created_at = now() - interval '2 days' where id = :'vnew';
set local role rikuy_worker;
create temp table c2 as select * from worker_api.claim_jobs('runner-b', 1, array['media.expire_abandoned_upload']);
select is(
  (select abandoned::text || '/' || coalesce(original_path, '-')
   from worker_api.abandoned_upload((select job_id from c2), (select fencing_token from c2))),
  'false/-', 'another tenant''s version is invisible to the job'
);
select is(worker_api.mark_upload_abandoned((select job_id from c2), (select fencing_token from c2)), 'not_found', 'and cannot be marked');
create temp table c3 as select * from worker_api.claim_jobs('runner-c', 1, array['system.probe']);
select throws_ok(
  format('select * from worker_api.abandoned_upload(%L, %s)', (select job_id from c3), (select fencing_token from c3)),
  '23514', null, 'a probe''s lease cannot inspect uploads'
);
reset role;
select is((select status::text from public.asset_versions where id = :'vnew'), 'uploading', 'tenant A''s version is still untouched');

-- ── Configured: the runner is woken, at most once every 10 s ──────────────
select vault.create_secret('https://runner.example.test/api/jobs/drain', 'rikuy_job_runner_url');
select vault.create_secret('local-test-runner-secret-0123456789abcdef', 'rikuy_job_runner_secret');
select private.enqueue_job(:'tb', 'system.probe', 'probe:configured');
select is(
  (select url || ' ' || (headers ->> 'Authorization') from net.http_request_queue),
  'https://runner.example.test/api/jobs/drain Bearer local-test-runner-secret-0123456789abcdef',
  'an enqueue wakes the runner with its secret'
);
select private.enqueue_job(:'tb', 'system.probe', 'probe:burst');
select is((select count(*)::int from net.http_request_queue), 1, 'a burst of enqueues wakes it once');
update private.job_runner_kicks set last_kick_at = now() - interval '1 minute';
update public.background_jobs set status = 'dead_letter', finished_at = now(), lease_owner = null, lease_until = null
where status in ('pending', 'running');
select ok(not private.kick_job_runner('schedule'), 'with nothing due, the schedule does not wake it');

select * from finish();
rollback;
