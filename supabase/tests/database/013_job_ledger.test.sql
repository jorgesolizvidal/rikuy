-- Durable job ledger (P2 · Paso 1): outbox idempotency, claims with leases and fencing,
-- retries, dead-letter, replay, fairness between tenants and the workload role's limits.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set op1 '00000000-0000-4000-8000-0000000000f1'
\set a1  '00000000-0000-4000-8000-0000000000a1'
\set b1  '00000000-0000-4000-8000-0000000000b1'
\set ta  'aaaaaaaa-0000-4000-8000-000000000001'
\set tb  'bbbbbbbb-0000-4000-8000-000000000001'
\set tc  'cccccccc-0000-4000-8000-000000000001'

\set op_aal1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set a1_aal2 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'

insert into auth.users (id, email) values
  (:'op1', 'operador@example.test'), (:'a1', 'owner.a@example.test'), (:'b1', 'owner.b@example.test');
insert into public.platform_operators (user_id, status) values (:'op1', 'active');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz'),
  (:'tc', 'tenant-c', 'Tenant C', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now()),
  (:'tb', :'b1', 'owner', 'active', now()),
  (:'tc', :'b1', 'owner', 'active', now());
update public.tenants set status = 'active' where id in (:'ta', :'tb');
set constraints all immediate;

-- pgTAP's own functions live in "extensions": let the workload role call them in this
-- (rolled back) transaction only.
grant usage on schema extensions to rikuy_worker;
-- …and keep its results in temporary tables (Supabase may not grant TEMP to everyone).
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

-- Helpers of this test: move a job's clock forward (as the database would see it later).
create function pg_temp.make_due(p_job uuid) returns void language sql as $$
  update public.background_jobs set available_at = now() - interval '1 second' where id = p_job;
$$;
create function pg_temp.expire_lease(p_job uuid) returns void language sql as $$
  update public.background_jobs set lease_until = now() - interval '1 second' where id = p_job;
$$;

select plan(71);

-- ── Privileges ──────────────────────────────────────────────────────────────
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('public.background_jobs'::regclass, 'public.job_attempts'::regclass,
                   'public.job_kinds'::regclass, 'public.job_queues'::regclass)),
  'RLS is enabled on every ledger table'
);
select ok(not has_table_privilege('anon', 'public.background_jobs', 'SELECT'), 'anon cannot read jobs');
select ok(not has_table_privilege('authenticated', 'public.background_jobs', 'SELECT'), 'users cannot read jobs directly');
select ok(not has_table_privilege('service_role', 'public.background_jobs', 'INSERT'), 'not even the service role writes jobs directly');
select ok(not has_table_privilege('rikuy_worker', 'public.background_jobs', 'SELECT'), 'the worker has no table privileges');
select ok(not has_function_privilege('authenticated', 'worker_api.claim_jobs(text, integer, text[])', 'EXECUTE'), 'users cannot claim jobs');
select ok(not has_function_privilege('service_role', 'worker_api.complete_job(uuid, bigint, jsonb, jsonb)', 'EXECUTE'), 'the service role cannot complete jobs');
select ok(not has_function_privilege('rikuy_worker', 'private.enqueue_job(uuid, text, text, jsonb, text, uuid, timestamptz, text)', 'EXECUTE'), 'the worker cannot enqueue arbitrary jobs');
select ok(not has_function_privilege('rikuy_worker', 'public.platform_replay_job(uuid, integer)', 'EXECUTE'), 'the worker cannot replay jobs');
select ok(not pg_has_role('authenticator', 'rikuy_worker', 'MEMBER'), 'no API key or JWT can become the worker');
select ok(
  (select not rolcanlogin from pg_roles where rolname = 'rikuy_worker'),
  'the worker role cannot log in until an operator enables it'
);

-- ── Outbox: idempotent enqueue ──────────────────────────────────────────────
create temp table q1 as select * from private.enqueue_job(:'ta', 'system.probe', 'probe:one', '{}'::jsonb);
create temp table q2 as select * from private.enqueue_job(:'ta', 'system.probe', 'probe:one', '{"mode":"fail_always"}'::jsonb);
select ok((select created from q1) and not (select created from q2), 'the second enqueue of a logical key creates nothing');
select is((select job_id from q2), (select job_id from q1), 'and returns the existing job');
select is(
  (select count(*)::int from public.background_jobs where logical_key = 'probe:one'), 1, 'one job per tenant, kind and logical key'
);
select is(
  (select payload from public.background_jobs where logical_key = 'probe:one'), '{}'::jsonb, 'the original intent is kept'
);
select lives_ok(
  format('select private.enqueue_job(%L, %L, %L)', :'tb', 'system.probe', 'probe:one'),
  'the same logical key in another tenant is another job'
);
select throws_ok(
  format('select private.enqueue_job(%L, %L, %L, %L)', :'ta', 'system.probe', 'probe:bad', '{"mode":"rm -rf"}'),
  '23514', null, 'an invalid payload is refused'
);
select throws_ok(
  format('select private.enqueue_job(%L, %L, %L)', :'ta', 'system.unknown', 'x'),
  '23514', null, 'an unknown kind is refused'
);
select throws_ok(
  format('select private.enqueue_job(%L, %L, %L)', :'ta', 'system.probe', 'has space'),
  '23514', null, 'an invalid logical key is refused'
);

-- More work: two more jobs of A, one of C (C will be suspended).
select private.enqueue_job(:'ta', 'system.probe', 'probe:two');
select private.enqueue_job(:'ta', 'system.probe', 'probe:three');
select private.enqueue_job(:'tc', 'system.probe', 'probe:suspended');
update public.tenants set status = 'suspended' where id = :'tc';
-- The seed's published content leaves knowledge.index jobs (ADR-037): out of the way here.
update public.background_jobs set available_at = now() + interval '1 day'
where kind = 'knowledge.index' and status = 'pending';

-- ── Claims: fairness and concurrency ───────────────────────────────────────
set local role rikuy_worker;
select throws_ok('select * from public.background_jobs', '42501', null, 'the worker cannot select jobs directly');
select throws_ok($$select * from worker_api.claim_jobs('bad runner')$$, '23514', null, 'a runner id is validated');
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 5);
reset role;

select is((select count(*)::int from c1), 2, 'a claim never exceeds the queue''s global concurrency (2)');
select is(
  (select count(distinct tenant_id)::int from c1), 2,
  'A has three jobs waiting, yet B gets one of the two slots (one running job per tenant)'
);
select ok(not exists (select 1 from c1 where tenant_id = :'tc'), 'a suspended tenant''s jobs are not claimed');
select ok(
  (select bool_and(fencing_token > 0 and lease_until > now() and attempt_no = 1) from c1),
  'every claim carries a fencing token, a live lease and its attempt number'
);
select is(
  (select count(*)::int from public.job_attempts a join c1 using (fencing_token) where a.outcome = 'running'),
  2, 'each claim opens an attempt'
);

set local role rikuy_worker;
create temp table c2 as select * from worker_api.claim_jobs('runner-b', 5);
reset role;
select is((select count(*)::int from c2), 0, 'nothing more is claimed while the queue is full');

-- ── Heartbeat, checkpoint and completion with fencing ──────────────────────
set local role rikuy_worker;
create temp table ja as select * from c1 where tenant_id = :'ta';
create temp table jb as select * from c1 where tenant_id = :'tb';
grant select on ja, jb to authenticated; -- read later by the operator's checks
select ok(
  worker_api.heartbeat((select job_id from ja), (select fencing_token from ja), '{"step":2}'::jsonb) >= now(),
  'a heartbeat with the current token renews the lease'
);
select throws_ok(
  format('select worker_api.heartbeat(%L, %s)', (select job_id from ja), (select fencing_token from ja) + 1000),
  'PT409', null, 'a heartbeat with another token is refused'
);
select throws_ok(
  format('select worker_api.heartbeat(%L, %s, %L)', (select job_id from ja), (select fencing_token from ja), '[1]'),
  '23514', null, 'a checkpoint must be an object'
);
select throws_ok(
  format('select worker_api.complete_job(%L, %s)', (select job_id from jb), (select fencing_token from ja)),
  'PT409', null, 'one job''s token cannot complete another job'
);
select lives_ok(
  format('select worker_api.complete_job(%L, %s, %L)', (select job_id from jb), (select fencing_token from jb), '{"ok":true}'),
  'the holder of the lease completes the job'
);
select throws_ok(
  format('select worker_api.complete_job(%L, %s)', (select job_id from jb), (select fencing_token from jb)),
  'PT409', null, 'a completed job cannot be completed twice'
);
reset role;

select is((select status from public.background_jobs where id = (select job_id from jb)), 'succeeded'::public.job_status, 'the job succeeded');
select is(
  (select outcome from public.job_attempts where fencing_token = (select fencing_token from jb)),
  'succeeded'::public.job_attempt_outcome, 'and so did its attempt'
);
select is((select checkpoint from public.background_jobs where id = (select job_id from ja)), '{"step":2}'::jsonb, 'the checkpoint was stored');

-- ── Lost lease: the old runner is fenced off ───────────────────────────────
select pg_temp.expire_lease((select job_id from ja));
set local role rikuy_worker;
-- A claim of a kind with no work still reaps expired leases first.
create temp table c3 as select * from worker_api.claim_jobs('runner-b', 1, array['system.none']);
reset role;
select ok(
  (select status = 'pending' and available_at > now() and lease_until is null
   from public.background_jobs where id = (select job_id from ja)),
  'an expired job goes back to the queue and waits for its backoff'
);
select is(
  (select outcome from public.job_attempts where fencing_token = (select fencing_token from ja)),
  'lease_expired'::public.job_attempt_outcome, 'the lost attempt is recorded'
);
select pg_temp.make_due((select job_id from ja));
set local role rikuy_worker;
create temp table c4 as select * from worker_api.claim_jobs('runner-b', 1, array['system.probe']);
reset role;
select is((select job_id from c4), (select job_id from ja), 'another runner claims it once due');
select ok((select fencing_token from c4) > (select fencing_token from ja), 'with a greater fencing token');
select is((select checkpoint from c4), '{"step":2}'::jsonb, 'and the checkpoint to resume from');
select is((select attempt_no from c4), 2, 'as the second attempt');

set local role rikuy_worker;
select throws_ok(
  format('select worker_api.complete_job(%L, %s)', (select job_id from ja), (select fencing_token from ja)),
  'PT409', null, 'the old runner, still alive, cannot complete the job'
);
select throws_ok(
  format('select worker_api.heartbeat(%L, %s)', (select job_id from ja), (select fencing_token from ja)),
  'PT409', null, 'nor renew its lease'
);
select is(
  worker_api.fail_job((select job_id from c4), (select fencing_token from c4), 'storage_unavailable',
    'GET https://x.example.test/object?token=SECRET failed', true),
  'pending'::public.job_status, 'a transient failure with attempts left goes back to the queue'
);
reset role;

select ok(
  (select available_at > now() and status = 'pending' and attempts = 2 from public.background_jobs where id = (select job_id from c4)),
  'with a backoff delay'
);
select ok(
  (select position('SECRET' in last_error_message) = 0 from public.background_jobs where id = (select job_id from c4)),
  'tokens in error messages are not stored'
);

-- Third and last attempt fails again: dead-letter.
select pg_temp.make_due((select job_id from c4));
set local role rikuy_worker;
create temp table c5 as select * from worker_api.claim_jobs('runner-c', 1, array['system.probe']);
select is(
  worker_api.fail_job((select job_id from c5), (select fencing_token from c5), 'storage_unavailable', 'still down', true),
  'dead_letter'::public.job_status, 'without attempts left, a transient failure goes to the dead-letter queue'
);
reset role;
select is((select job_id from c5), (select job_id from ja), 'it was the same job');

-- A permanent failure does not retry.
select pg_temp.make_due(id) from public.background_jobs where status = 'pending';
set local role rikuy_worker;
create temp table c6 as select * from worker_api.claim_jobs('runner-c', 1, array['system.probe']);
select is(
  worker_api.fail_job((select job_id from c6), (select fencing_token from c6), 'invalid_source', 'not an image', false),
  'dead_letter'::public.job_status, 'a permanent failure goes straight to dead-letter'
);
select throws_ok(
  format('select worker_api.fail_job(%L, %s, %L, %L, true)', (select job_id from c6), (select fencing_token from c6), 'Bad Code', 'x'),
  '23514', null, 'error codes are validated'
);
reset role;

-- Time budget: an attempt past max_active_seconds cannot keep its lease.
select pg_temp.make_due(id) from public.background_jobs where status = 'pending';
set local role rikuy_worker;
create temp table c7 as select * from worker_api.claim_jobs('runner-d', 1, array['system.probe']);
reset role;
-- (The clock moves on: the attempt started 10 min ago. The guard trigger is paused for it.)
alter table public.job_attempts disable trigger job_attempts_protect;
update public.job_attempts set started_at = now() - interval '10 minutes' where fencing_token = (select fencing_token from c7);
alter table public.job_attempts enable trigger job_attempts_protect;
set local role rikuy_worker;
select throws_ok(
  format('select worker_api.heartbeat(%L, %s)', (select job_id from c7), (select fencing_token from c7)),
  'PT408', null, 'a heartbeat past the time budget is refused'
);
reset role;

-- Reaping at the last attempt: dead-letter.
update public.background_jobs set attempts = max_attempts where id = (select job_id from c7);
select pg_temp.expire_lease((select job_id from c7));
set local role rikuy_worker;
select is(worker_api.reap_expired_jobs(), 1, 'the reconciler recovers the expired lease');
reset role;
select is(
  (select status from public.background_jobs where id = (select job_id from c7)),
  'dead_letter'::public.job_status, 'without attempts left it goes to dead-letter'
);

-- ── Attempts are append-only ───────────────────────────────────────────────
select throws_ok(
  format('delete from public.job_attempts where fencing_token = %s', (select fencing_token from jb)),
  '42501', null, 'attempts cannot be deleted'
);
select throws_ok(
  format('update public.job_attempts set outcome = %L where fencing_token = %s', 'failed', (select fencing_token from jb)),
  '42501', null, 'a closed attempt cannot change'
);

-- ── Backoff ─────────────────────────────────────────────────────────────────
select ok(
  (select bool_and(d between interval '2.5 seconds' and interval '5 seconds')
   from (select private.job_retry_delay(1) d from generate_series(1, 50)) s),
  'first retry: 2.5–5 s'
);
select ok(
  (select bool_and(d between interval '150 seconds' and interval '300 seconds')
   from (select private.job_retry_delay(12) d from generate_series(1, 50)) s),
  'the delay never exceeds 5 min'
);
select ok(private.job_retry_delay(1, 600) >= interval '600 seconds', 'a Retry-After is respected');

-- ── Operators: dead-letter queue, replay and probes ────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1_aal2';
select throws_ok('select * from public.platform_list_jobs()', '42501', null, 'a tenant owner cannot list the ledger');
set local request.jwt.claims to :'op_aal1';
select throws_ok('select * from public.platform_job_summary()', '42501', null, 'an operator without MFA cannot either');
set local request.jwt.claims to :'op_aal2';
select ok(
  (select dead_letter >= 3 from public.platform_job_summary()), 'the operator sees the dead-letter count'
);
select is(
  (select count(*)::int from public.platform_list_jobs('dead_letter') where tenant_id in (:'ta', :'tb', :'tc')),
  3, 'and lists the dead-letter jobs'
);
select throws_ok(
  format('select public.platform_replay_job(%L, 1)', (select job_id from jb)),
  'PT409', null, 'a succeeded job cannot be replayed'
);
select throws_ok(
  format('select public.platform_replay_job(%L, 2)', (select job_id from ja)),
  'PT409', null, 'a replay must name the current generation'
);
select is(public.platform_replay_job((select job_id from ja), 1), 2, 'a dead-letter job is replayed as generation 2');
select is(
  (select count(*)::int from public.platform_job_attempts((select job_id from ja))), 3,
  'the history of the first generation stays'
);
select throws_ok(
  format('select public.platform_enqueue_probe(%L, %L)', :'ta', 'drop'),
  '23514', null, 'a probe mode is validated'
);
create temp table probe as select public.platform_enqueue_probe(:'tb', 'fail_once') as job_id;
reset role;

select ok(
  (select status = 'pending' and generation = 2 and attempts = 0 and finished_at is null
   from public.background_jobs where id = (select job_id from ja)),
  'the replayed job is pending again with fresh attempts'
);
select is(
  (select count(*)::int from public.audit_events
   where action in ('job.replayed', 'job.probe_requested') and tenant_id in (:'ta', :'tb')),
  2, 'replays and probes are audited'
);
select is(
  (select payload from public.background_jobs where id = (select job_id from probe)),
  '{"mode":"fail_once"}'::jsonb, 'the probe was enqueued for tenant B'
);

select * from finish();
rollback;
