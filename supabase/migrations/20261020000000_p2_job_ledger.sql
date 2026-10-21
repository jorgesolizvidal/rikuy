-- ─────────────────────────────────────────────────────────────────────────────
-- P2 · Paso 1: durable job ledger (ADR-014 contract, runtime on Vercel per ADR-019).
--
--   * background_jobs is the OUTBOX and the LEDGER: the transaction that accepts an
--     operation inserts the job (idempotent per tenant + kind + logical key). The database
--     is the source of truth and the clock; the runtime is replaceable.
--   * A runner claims jobs atomically and gets a LEASE (lease_until) and a monotonic
--     FENCING TOKEN. Heartbeats, checkpoints and the final result are accepted only with
--     the current token and a live lease: a runner that lost its lease cannot write.
--   * Expired leases are reaped (the attempt is recorded as lost); transient failures are
--     retried with exponential backoff and jitter; exhausted or permanent failures go to
--     the dead-letter state, visible to platform operators, who can replay them (new
--     generation, audited).
--   * Fairness: per-queue global concurrency and per-tenant concurrency are enforced at
--     claim time in the database, and tenants with fewer running jobs are served first,
--     so one municipality cannot starve another.
--   * The worker connects as the dedicated role rikuy_worker: NOLOGIN here (an operator
--     enables LOGIN with a password out of band), no table privileges, EXECUTE only on the
--     functions of schema worker_api. Never service_role, never a user's session.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Workload role and its API schema ───────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rikuy_worker') then
    create role rikuy_worker nologin noinherit;
  end if;
end;
$$;

-- Lets migrations and pgTAP tests act as the worker (SET ROLE). PostgREST's authenticator
-- is NOT a member: no API key or JWT can switch to this role.
grant rikuy_worker to postgres;

create schema worker_api;
revoke all on schema worker_api from public;
grant usage on schema worker_api to rikuy_worker;

-- ── Types ───────────────────────────────────────────────────────────────────

create type public.job_status as enum ('pending', 'running', 'succeeded', 'dead_letter');
create type public.job_attempt_outcome as enum ('running', 'succeeded', 'retry', 'failed', 'lease_expired');

-- ── Queues and kinds (platform configuration, not tenant data) ─────────────

create table public.job_queues (
  queue              text primary key,
  global_concurrency integer not null,

  constraint job_queues_name check (queue ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint job_queues_concurrency check (global_concurrency between 1 and 50)
);

create table public.job_kinds (
  kind               text primary key,
  queue              text not null references public.job_queues (queue) on delete restrict,
  max_attempts       integer not null,
  lease_seconds      integer not null,
  -- Product budget for one attempt (ADR-014: 15 min for media); heartbeats past it are refused.
  max_active_seconds integer not null,
  tenant_concurrency integer not null,
  -- Short name shown to operators ("Prueba del ejecutor", "Panorama").
  description        text not null,

  constraint job_kinds_name check (kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint job_kinds_attempts check (max_attempts between 1 and 10),
  constraint job_kinds_lease check (lease_seconds between 30 and 900),
  constraint job_kinds_budget check (max_active_seconds between lease_seconds and 3600),
  constraint job_kinds_tenant_concurrency check (tenant_concurrency between 1 and 10),
  constraint job_kinds_description check (char_length(description) between 1 and 60)
);

insert into public.job_queues (queue, global_concurrency) values
  ('system', 2),
  ('media', 2),
  ('knowledge', 2);

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values (
  'system.probe', 'system', 3, 60, 120, 1,
  'Prueba del ejecutor'
);

-- ── Jobs ────────────────────────────────────────────────────────────────────

create sequence private.job_fencing_token_seq as bigint;

create table public.background_jobs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete restrict,
  kind               text not null references public.job_kinds (kind) on delete restrict,
  schema_version     smallint not null default 1,
  logical_key        text not null,
  payload            jsonb not null default '{}'::jsonb,
  subject_type       text,
  subject_id         uuid,
  status             public.job_status not null default 'pending',
  available_at       timestamptz not null default now(),
  generation         integer not null default 1,
  attempts           integer not null default 0,
  max_attempts       integer not null,
  fencing_token      bigint not null default 0,
  lease_owner        text,
  lease_until        timestamptz,
  heartbeat_at       timestamptz,
  checkpoint         jsonb,
  result             jsonb,
  last_error_code    text,
  last_error_message text,
  trace_id           text,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  first_started_at   timestamptz,
  finished_at        timestamptz,

  constraint background_jobs_tenant_id_id_key unique (tenant_id, id),
  constraint background_jobs_logical_key_key unique (tenant_id, kind, logical_key),
  constraint background_jobs_schema_version check (schema_version >= 1),
  constraint background_jobs_logical_key_format check (logical_key ~ '^[A-Za-z0-9:._/-]{1,200}$'),
  constraint background_jobs_payload_object check (
    jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192
  ),
  constraint background_jobs_subject check (
    (subject_type is null) = (subject_id is null)
    and (subject_type is null or subject_type ~ '^[a-z][a-z0-9_]{1,40}$')
  ),
  constraint background_jobs_generation check (generation >= 1),
  constraint background_jobs_attempts check (attempts between 0 and max_attempts),
  constraint background_jobs_max_attempts check (max_attempts between 1 and 10),
  constraint background_jobs_running_has_lease check (
    (status = 'running') = (lease_owner is not null and lease_until is not null)
  ),
  constraint background_jobs_finished check (
    (status in ('succeeded', 'dead_letter')) = (finished_at is not null)
  ),
  constraint background_jobs_checkpoint check (
    checkpoint is null or (jsonb_typeof(checkpoint) = 'object' and pg_column_size(checkpoint) <= 16384)
  ),
  constraint background_jobs_result check (
    result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 8192)
  ),
  constraint background_jobs_error_code check (
    last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  constraint background_jobs_error_message check (
    last_error_message is null or char_length(last_error_message) <= 500
  ),
  constraint background_jobs_trace check (trace_id is null or trace_id ~ '^[A-Za-z0-9-]{8,64}$'),
  constraint background_jobs_lease_owner check (
    lease_owner is null or lease_owner ~ '^[A-Za-z0-9._:-]{1,100}$'
  )
);

create index background_jobs_pending_idx on public.background_jobs (available_at) where status = 'pending';
create index background_jobs_running_idx on public.background_jobs (lease_until) where status = 'running';
create index background_jobs_running_tenant_idx on public.background_jobs (tenant_id, kind) where status = 'running';
create index background_jobs_tenant_time_idx on public.background_jobs (tenant_id, created_at desc);
create index background_jobs_status_time_idx on public.background_jobs (status, created_at desc);

create trigger background_jobs_touch_updated_at
  before update on public.background_jobs
  for each row execute function private.touch_updated_at();
create trigger background_jobs_forbid_tenant_change
  before update of tenant_id on public.background_jobs
  for each row execute function private.forbid_tenant_change();

-- ── Attempts (append-only history) ─────────────────────────────────────────

create table public.job_attempts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  job_id        uuid not null,
  generation    integer not null,
  attempt_no    integer not null,
  fencing_token bigint not null,
  runner_id     text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  outcome       public.job_attempt_outcome not null default 'running',
  error_code    text,
  error_message text,
  metrics       jsonb,

  constraint job_attempts_job_fkey foreign key (tenant_id, job_id)
    references public.background_jobs (tenant_id, id) on delete restrict,
  constraint job_attempts_number_key unique (job_id, generation, attempt_no),
  constraint job_attempts_fencing_token_key unique (fencing_token),
  constraint job_attempts_runner check (runner_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  constraint job_attempts_closed check ((outcome = 'running') = (finished_at is null)),
  constraint job_attempts_error_code check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  constraint job_attempts_error_message check (error_message is null or char_length(error_message) <= 500),
  constraint job_attempts_metrics check (
    metrics is null or (jsonb_typeof(metrics) = 'object' and pg_column_size(metrics) <= 2048)
  )
);

create index job_attempts_job_idx on public.job_attempts (job_id, generation, attempt_no);
create index job_attempts_tenant_time_idx on public.job_attempts (tenant_id, started_at desc);

-- An attempt is written once when it starts and once when it ends; never deleted.
create function private.protect_job_attempt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'job attempts are append-only' using errcode = '42501';
  end if;
  if old.outcome <> 'running'
     or new.job_id <> old.job_id or new.tenant_id <> old.tenant_id
     or new.generation <> old.generation or new.attempt_no <> old.attempt_no
     or new.fencing_token <> old.fencing_token or new.runner_id <> old.runner_id
     or new.started_at <> old.started_at then
    raise exception 'a closed attempt cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger job_attempts_protect
  before update or delete on public.job_attempts
  for each row execute function private.protect_job_attempt();

-- ── Privileges: nobody touches these tables directly ───────────────────────

revoke all on table public.job_queues, public.job_kinds, public.background_jobs, public.job_attempts
  from public, anon, authenticated, service_role;
revoke all on sequence private.job_fencing_token_seq from public;

alter table public.job_queues enable row level security;
alter table public.job_kinds enable row level security;
alter table public.background_jobs enable row level security;
alter table public.job_attempts enable row level security;
-- No policies: every read and write goes through the SECURITY DEFINER functions below.

-- ── Internal helpers ────────────────────────────────────────────────────────

-- Exponential backoff with jitter (ADR-014): base 5 s, ceiling 5 min, a Retry-After from
-- the failing service is respected up to 1 h. Half the delay is fixed, half random.
create function private.job_retry_delay(p_attempt integer, p_retry_after_seconds integer default null)
returns interval
language sql
volatile
set search_path = ''
as $$
  select make_interval(secs => greatest(
    least(300, 5 * power(2, greatest(p_attempt, 1) - 1)) * (0.5 + random() * 0.5),
    least(greatest(coalesce(p_retry_after_seconds, 0), 0), 3600)
  ));
$$;

create function private.is_valid_job_payload(p_kind text, p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    -- {"mode": "ok" | "fail_once" | "fail_always", "workMs": 0..10000}, both optional.
    when 'system.probe' then
      jsonb_typeof(p_payload) = 'object'
      and not exists (
        select 1 from jsonb_object_keys(p_payload) k where k not in ('mode', 'workMs')
      )
      and (not p_payload ? 'mode' or p_payload ->> 'mode' in ('ok', 'fail_once', 'fail_always'))
      and (
        not p_payload ? 'workMs'
        or (
          jsonb_typeof(p_payload -> 'workMs') = 'number'
          and (p_payload ->> 'workMs') ~ '^[0-9]{1,5}$'
          and (p_payload ->> 'workMs')::integer between 0 and 10000
        )
      )
    else false
  end;
$$;

-- The outbox write, called by the transaction that accepts an operation. Idempotent: the
-- same tenant + kind + logical key returns the existing job instead of a second one.
create function private.enqueue_job(
  p_tenant_id uuid,
  p_kind text,
  p_logical_key text,
  p_payload jsonb default '{}'::jsonb,
  p_subject_type text default null,
  p_subject_id uuid default null,
  p_available_at timestamptz default null,
  p_trace_id text default null
)
returns table (job_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_kind public.job_kinds;
  v_id uuid;
begin
  select * into v_kind from public.job_kinds k where k.kind = p_kind;
  if not found then
    raise exception 'unknown job kind' using errcode = '23514', hint = 'kind';
  end if;
  if not private.is_valid_job_payload(p_kind, coalesce(p_payload, '{}'::jsonb)) then
    raise exception 'invalid job payload' using errcode = '23514', hint = 'payload';
  end if;

  insert into public.background_jobs (
    tenant_id, kind, logical_key, payload, subject_type, subject_id, available_at,
    max_attempts, trace_id, created_by
  )
  values (
    p_tenant_id, p_kind, p_logical_key, coalesce(p_payload, '{}'::jsonb), p_subject_type,
    p_subject_id, coalesce(p_available_at, now()), v_kind.max_attempts, p_trace_id,
    (select auth.uid())
  )
  on conflict on constraint background_jobs_logical_key_key do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;
  return query
  select j.id, false from public.background_jobs j
  where j.tenant_id = p_tenant_id and j.kind = p_kind and j.logical_key = p_logical_key;
end;
$$;

-- Expired leases: the attempt is recorded as lost; the job goes back to the queue (with
-- backoff) or, without attempts left, to the dead-letter state.
create function private.reap_expired_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_count integer := 0;
begin
  for v_job in
    select * from public.background_jobs j
    where j.status = 'running' and j.lease_until < now()
    order by j.lease_until
    for update skip locked
  loop
    update public.job_attempts a
    set outcome = 'lease_expired', finished_at = now(), error_code = 'lease_expired',
        error_message = 'The runner stopped renewing its lease.'
    where a.job_id = v_job.id and a.fencing_token = v_job.fencing_token and a.outcome = 'running';

    if v_job.attempts >= v_job.max_attempts then
      update public.background_jobs j
      set status = 'dead_letter', finished_at = now(), lease_owner = null, lease_until = null,
          last_error_code = 'lease_expired',
          last_error_message = 'The runner stopped renewing its lease and no attempts are left.'
      where j.id = v_job.id;
    else
      update public.background_jobs j
      set status = 'pending', available_at = now() + private.job_retry_delay(v_job.attempts),
          lease_owner = null, lease_until = null,
          last_error_code = 'lease_expired',
          last_error_message = 'The runner stopped renewing its lease.'
      where j.id = v_job.id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- The job row of a live lease held with this token, locked; otherwise "lease lost".
create function private.leased_job(p_job_id uuid, p_fencing_token bigint)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
begin
  select * into v_job from public.background_jobs j where j.id = p_job_id for update;
  if not found
     or v_job.status <> 'running'
     or v_job.fencing_token <> p_fencing_token
     or v_job.lease_until < now() then
    raise exception 'lease lost' using errcode = 'PT409', hint = 'lease';
  end if;
  return v_job;
end;
$$;

create function private.clean_error_message(p_message text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Signed URLs and tokens never reach the ledger: query strings are cut off.
  select nullif(left(regexp_replace(coalesce(p_message, ''), '\?[^\s]*', '?…', 'g'), 500), '');
$$;

revoke all on function private.protect_job_attempt() from public;
revoke all on function private.job_retry_delay(integer, integer) from public;
revoke all on function private.is_valid_job_payload(text, jsonb) from public;
revoke all on function private.enqueue_job(uuid, text, text, jsonb, text, uuid, timestamptz, text) from public;
revoke all on function private.reap_expired_jobs() from public;
revoke all on function private.leased_job(uuid, bigint) from public;
revoke all on function private.clean_error_message(text) from public;

-- ── worker_api: the only surface of the workload role ──────────────────────
-- Error codes: PT409 hint 'lease' (lease lost: stop, do not write) · PT408 hint
-- 'time_budget' (the attempt ran past its budget) · 23514 invalid input.

create function worker_api.claim_jobs(
  p_runner_id text,
  p_limit integer default 1,
  p_kinds text[] default null
)
returns table (
  job_id             uuid,
  tenant_id          uuid,
  kind               text,
  schema_version     smallint,
  payload            jsonb,
  checkpoint         jsonb,
  generation         integer,
  attempt_no         integer,
  fencing_token      bigint,
  lease_until        timestamptz,
  lease_seconds      integer,
  max_active_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_job public.background_jobs;
  v_kind public.job_kinds;
  v_token bigint;
  v_claimed integer := 0;
begin
  if p_runner_id is null or p_runner_id !~ '^[A-Za-z0-9._:-]{1,100}$' then
    raise exception 'invalid runner id' using errcode = '23514';
  end if;
  if p_limit is null or p_limit not between 1 and 10 then
    raise exception 'limit must be between 1 and 10' using errcode = '23514';
  end if;

  -- One claimer at a time: concurrency counts below must not race. Claims are short.
  perform pg_advisory_xact_lock(hashtext('rikuy.background_jobs.claim'));
  perform private.reap_expired_jobs();

  while v_claimed < p_limit loop
    select j.* into v_job
    from public.background_jobs j
    join public.job_kinds k on k.kind = j.kind
    join public.job_queues q on q.queue = k.queue
    join public.tenants t on t.id = j.tenant_id
    where j.status = 'pending'
      and j.available_at <= now()
      and t.status <> 'suspended'
      and (p_kinds is null or j.kind = any (p_kinds))
      and (
        select count(*) from public.background_jobs r
        join public.job_kinds rk on rk.kind = r.kind
        where r.status = 'running' and rk.queue = k.queue
      ) < q.global_concurrency
      and (
        select count(*) from public.background_jobs r
        join public.job_kinds rk on rk.kind = r.kind
        where r.status = 'running' and r.tenant_id = j.tenant_id and rk.queue = k.queue
      ) < k.tenant_concurrency
    order by
      (select count(*) from public.background_jobs r
       where r.status = 'running' and r.tenant_id = j.tenant_id),
      j.available_at,
      j.created_at
    limit 1
    for update of j skip locked;

    exit when not found;

    select * into v_kind from public.job_kinds k where k.kind = v_job.kind;
    v_token := nextval('private.job_fencing_token_seq');

    update public.background_jobs j
    set status = 'running',
        attempts = j.attempts + 1,
        fencing_token = v_token,
        lease_owner = p_runner_id,
        lease_until = now() + make_interval(secs => v_kind.lease_seconds),
        heartbeat_at = now(),
        first_started_at = coalesce(j.first_started_at, now())
    where j.id = v_job.id
    returning * into v_job;

    insert into public.job_attempts (tenant_id, job_id, generation, attempt_no, fencing_token, runner_id)
    values (v_job.tenant_id, v_job.id, v_job.generation, v_job.attempts, v_token, p_runner_id);

    return query select
      v_job.id, v_job.tenant_id, v_job.kind, v_job.schema_version, v_job.payload,
      v_job.checkpoint, v_job.generation, v_job.attempts, v_token, v_job.lease_until,
      v_kind.lease_seconds, v_kind.max_active_seconds;
    v_claimed := v_claimed + 1;
  end loop;
end;
$$;

-- Renews the lease and, optionally, stores a checkpoint to resume from.
create function worker_api.heartbeat(
  p_job_id uuid,
  p_fencing_token bigint,
  p_checkpoint jsonb default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_kind public.job_kinds;
  v_started timestamptz;
  v_until timestamptz;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  select * into v_kind from public.job_kinds k where k.kind = v_job.kind;
  select a.started_at into v_started from public.job_attempts a where a.fencing_token = p_fencing_token;

  if v_started + make_interval(secs => v_kind.max_active_seconds) < now() then
    raise exception 'the attempt ran past its time budget' using errcode = 'PT408', hint = 'time_budget';
  end if;
  if p_checkpoint is not null and (
    jsonb_typeof(p_checkpoint) <> 'object' or pg_column_size(p_checkpoint) > 16384
  ) then
    raise exception 'invalid checkpoint' using errcode = '23514';
  end if;

  v_until := now() + make_interval(secs => v_kind.lease_seconds);
  update public.background_jobs j
  set lease_until = v_until, heartbeat_at = now(), checkpoint = coalesce(p_checkpoint, j.checkpoint)
  where j.id = p_job_id;
  return v_until;
end;
$$;

create function worker_api.complete_job(
  p_job_id uuid,
  p_fencing_token bigint,
  p_result jsonb default '{}'::jsonb,
  p_metrics jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);

  update public.background_jobs j
  set status = 'succeeded', result = coalesce(p_result, '{}'::jsonb), finished_at = now(),
      lease_owner = null, lease_until = null, last_error_code = null, last_error_message = null
  where j.id = v_job.id;

  update public.job_attempts a
  set outcome = 'succeeded', finished_at = now(), metrics = p_metrics
  where a.fencing_token = p_fencing_token and a.outcome = 'running';
end;
$$;

-- A failed attempt: retried later when transient and attempts remain, otherwise dead-letter.
-- Returns the job's new status.
create function worker_api.fail_job(
  p_job_id uuid,
  p_fencing_token bigint,
  p_error_code text,
  p_error_message text,
  p_retryable boolean,
  p_retry_after_seconds integer default null,
  p_metrics jsonb default null
)
returns public.job_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_message text := private.clean_error_message(p_error_message);
  v_retry boolean;
begin
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'invalid error code' using errcode = '23514';
  end if;
  v_job := private.leased_job(p_job_id, p_fencing_token);
  v_retry := coalesce(p_retryable, false) and v_job.attempts < v_job.max_attempts;

  update public.job_attempts a
  set outcome = case when v_retry then 'retry'::public.job_attempt_outcome else 'failed' end,
      finished_at = now(), error_code = p_error_code, error_message = v_message, metrics = p_metrics
  where a.fencing_token = p_fencing_token and a.outcome = 'running';

  if v_retry then
    update public.background_jobs j
    set status = 'pending',
        available_at = now() + private.job_retry_delay(v_job.attempts, p_retry_after_seconds),
        lease_owner = null, lease_until = null,
        last_error_code = p_error_code, last_error_message = v_message
    where j.id = v_job.id;
    return 'pending'::public.job_status;
  end if;

  update public.background_jobs j
  set status = 'dead_letter', finished_at = now(), lease_owner = null, lease_until = null,
      last_error_code = p_error_code, last_error_message = v_message
  where j.id = v_job.id;
  return 'dead_letter'::public.job_status;
end;
$$;

-- For the reconciler (scheduled): returns how many expired leases were recovered.
create function worker_api.reap_expired_jobs()
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.reap_expired_jobs();
$$;

revoke all on all functions in schema worker_api from public, anon, authenticated, service_role;
grant execute on function worker_api.claim_jobs(text, integer, text[]) to rikuy_worker;
grant execute on function worker_api.heartbeat(uuid, bigint, jsonb) to rikuy_worker;
grant execute on function worker_api.complete_job(uuid, bigint, jsonb, jsonb) to rikuy_worker;
grant execute on function worker_api.fail_job(uuid, bigint, text, text, boolean, integer, jsonb) to rikuy_worker;
grant execute on function worker_api.reap_expired_jobs() to rikuy_worker;

-- ── Platform operators: the ledger, the dead-letter queue and replays ──────
-- No payload, checkpoint or result leaves through here: only safe state.

create function public.platform_job_summary()
returns table (
  pending            bigint,
  due                bigint,
  running            bigint,
  dead_letter        bigint,
  succeeded_last_day bigint,
  oldest_due_at      timestamptz,
  -- The database's clock (the ledger's authority): pages compare dates with it.
  checked_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  return query
  select
    count(*) filter (where j.status = 'pending'),
    count(*) filter (where j.status = 'pending' and j.available_at <= now()),
    count(*) filter (where j.status = 'running'),
    count(*) filter (where j.status = 'dead_letter'),
    count(*) filter (where j.status = 'succeeded' and j.finished_at > now() - interval '1 day'),
    min(j.available_at) filter (where j.status = 'pending' and j.available_at <= now()),
    now()
  from public.background_jobs j;
end;
$$;

create function public.platform_list_jobs(
  p_status public.job_status default null,
  p_tenant_id uuid default null,
  p_limit integer default 100
)
returns table (
  job_id             uuid,
  tenant_id          uuid,
  tenant_name        text,
  kind               text,
  kind_description   text,
  status             public.job_status,
  generation         integer,
  attempts           integer,
  max_attempts       integer,
  available_at       timestamptz,
  created_at         timestamptz,
  first_started_at   timestamptz,
  finished_at        timestamptz,
  lease_until        timestamptz,
  last_error_code    text,
  last_error_message text,
  subject_type       text,
  subject_id         uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'limit must be between 1 and 500' using errcode = '23514';
  end if;
  return query
  select
    j.id, j.tenant_id, t.display_name, j.kind, k.description, j.status, j.generation,
    j.attempts, j.max_attempts, j.available_at, j.created_at, j.first_started_at,
    j.finished_at, j.lease_until, j.last_error_code, j.last_error_message,
    j.subject_type, j.subject_id
  from public.background_jobs j
  join public.tenants t on t.id = j.tenant_id
  join public.job_kinds k on k.kind = j.kind
  where (p_status is null or j.status = p_status)
    and (p_tenant_id is null or j.tenant_id = p_tenant_id)
  order by
    (j.status = 'dead_letter') desc,
    (j.status = 'running') desc,
    j.created_at desc
  limit p_limit;
end;
$$;

create function public.platform_job_attempts(p_job_id uuid)
returns table (
  generation    integer,
  attempt_no    integer,
  runner_id     text,
  started_at    timestamptz,
  finished_at   timestamptz,
  outcome       public.job_attempt_outcome,
  error_code    text,
  error_message text,
  duration_ms   integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  return query
  select
    a.generation, a.attempt_no, a.runner_id, a.started_at, a.finished_at, a.outcome,
    a.error_code, a.error_message,
    case when a.finished_at is null then null
         else (extract(epoch from (a.finished_at - a.started_at)) * 1000)::integer end
  from public.job_attempts a
  where a.job_id = p_job_id
  order by a.generation desc, a.attempt_no desc;
end;
$$;

-- Replay of a dead-letter job: a new generation with fresh attempts; the history of the
-- previous ones stays. Optimistic: the caller states the generation it saw.
create function public.platform_replay_job(p_job_id uuid, p_expected_generation integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
begin
  perform private.assert_platform_actor();

  select * into v_job from public.background_jobs j where j.id = p_job_id for update;
  if not found then
    raise exception 'job not found' using errcode = 'PT404';
  end if;
  if v_job.status <> 'dead_letter' or v_job.generation <> p_expected_generation then
    raise exception 'only the current dead-letter generation can be replayed'
      using errcode = 'PT409', hint = 'status';
  end if;

  update public.background_jobs j
  set status = 'pending', generation = j.generation + 1, attempts = 0,
      available_at = now(), finished_at = null, result = null
  where j.id = p_job_id;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', v_job.tenant_id, (select auth.uid()), 'job.replayed', 'background_job', v_job.id,
    v_job.id, 'success',
    jsonb_build_object(
      'kind', v_job.kind, 'fromGeneration', v_job.generation,
      'toGeneration', v_job.generation + 1, 'lastError', v_job.last_error_code
    )
  );
  return v_job.generation + 1;
end;
$$;

-- «Probar el ejecutor»: a probe job for a municipality, to check the pipeline end to end
-- or to rehearse failures (fail_once → one retry; fail_always → dead-letter).
create function public.platform_enqueue_probe(p_tenant_id uuid, p_mode text default 'ok')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job uuid;
begin
  perform private.assert_platform_actor();
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'tenant not found' using errcode = 'PT404', hint = 'tenant';
  end if;

  select e.job_id into v_job
  from private.enqueue_job(
    p_tenant_id, 'system.probe', 'probe:' || gen_random_uuid()::text,
    jsonb_build_object('mode', p_mode)
  ) e;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', p_tenant_id, (select auth.uid()), 'job.probe_requested', 'background_job', v_job,
    v_job, 'success', jsonb_build_object('mode', p_mode)
  );
  return v_job;
end;
$$;

revoke all on function public.platform_job_summary() from public, anon, authenticated;
revoke all on function public.platform_list_jobs(public.job_status, uuid, integer) from public, anon, authenticated;
revoke all on function public.platform_job_attempts(uuid) from public, anon, authenticated;
revoke all on function public.platform_replay_job(uuid, integer) from public, anon, authenticated;
revoke all on function public.platform_enqueue_probe(uuid, text) from public, anon, authenticated;

grant execute on function public.platform_job_summary() to authenticated;
grant execute on function public.platform_list_jobs(public.job_status, uuid, integer) to authenticated;
grant execute on function public.platform_job_attempts(uuid) to authenticated;
grant execute on function public.platform_replay_job(uuid, integer) to authenticated;
grant execute on function public.platform_enqueue_probe(uuid, text) to authenticated;
