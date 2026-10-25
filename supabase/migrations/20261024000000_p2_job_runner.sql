-- ─────────────────────────────────────────────────────────────────────────────
-- P2 · Paso 2: waking the job runner, and the first real job.
--
--   * The database wakes the runner (a protected endpoint of the web deployment): right
--     after a job becomes due (trigger) and, as a safety net, every minute (pg_cron) when
--     there is due work or an expired lease. Calls go through pg_net, which sends them only
--     after the transaction commits, so a rolled-back enqueue never wakes anybody.
--   * Where to call and with which secret live in Supabase Vault, set once by an operator
--     (docs/jobs.md); without them nothing is called. The secret only lets its holder ask
--     for a drain: it is NOT the Supabase secret key (pg_net keeps queued requests readable
--     to roles with access to its schema until they are sent).
--   * Kicks are debounced (one every 10 s at most): bursts of enqueues wake the runner once.
--   * First real job: media.expire_abandoned_upload. A daily sweep finds image versions
--     still 'uploading' after 24 h (the signed upload URL expired long ago); the runner
--     removes the original if it was ever written and marks the version rejected.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ── Waking the runner ───────────────────────────────────────────────────────

create table private.job_runner_kicks (
  id           smallint primary key default 1,
  last_kick_at timestamptz not null,
  last_reason  text not null,

  constraint job_runner_kicks_single_row check (id = 1),
  constraint job_runner_kicks_reason check (last_reason in ('enqueue', 'schedule'))
);
revoke all on table private.job_runner_kicks from public;

-- Is there anything for a runner to do now? (due work, or a lease to recover)
create function private.job_runner_has_work()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.background_jobs j
    where j.status = 'pending' and j.available_at <= now()
  ) or exists (
    select 1 from public.background_jobs j
    where j.status = 'running' and j.lease_until < now()
  );
$$;

-- Asks the runner to drain the queue. Returns whether a request was queued.
create function private.kick_job_runner(p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_kicked boolean;
begin
  if p_reason is null or p_reason not in ('enqueue', 'schedule') then
    raise exception 'invalid kick reason' using errcode = '23514';
  end if;
  if not private.job_runner_has_work() then
    return false;
  end if;

  select s.decrypted_secret into v_url
  from vault.decrypted_secrets s where s.name = 'rikuy_job_runner_url';
  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s where s.name = 'rikuy_job_runner_secret';
  -- Not configured (local development, CI, or before the operator sets it): nothing to do.
  if v_url is null or v_secret is null or v_url !~ '^https?://' then
    return false;
  end if;

  -- Debounce: at most one kick every 10 seconds.
  insert into private.job_runner_kicks as k (id, last_kick_at, last_reason)
  values (1, now(), p_reason)
  on conflict (id) do update
    set last_kick_at = excluded.last_kick_at, last_reason = excluded.last_reason
    where k.last_kick_at < now() - interval '10 seconds'
  returning true into v_kicked;
  if v_kicked is null then
    return false;
  end if;

  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('reason', p_reason),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    timeout_milliseconds := 5000
  );
  return true;
end;
$$;

-- A job was written ready to run (enqueued or replayed): wake the runner. Retries that come
-- due later are picked up by the every-minute schedule.
create function private.kick_on_job_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.kick_job_runner('enqueue');
  return null;
end;
$$;

create trigger background_jobs_kick_runner
  after insert or update of status, available_at on public.background_jobs
  for each row
  when (new.status = 'pending' and new.available_at <= now())
  execute function private.kick_on_job_ready();

revoke all on function private.job_runner_has_work() from public;
revoke all on function private.kick_job_runner(text) from public;
revoke all on function private.kick_on_job_ready() from public;

-- ── First real job: expire abandoned uploads ───────────────────────────────

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values ('media.expire_abandoned_upload', 'media', 5, 60, 120, 1, 'Limpieza de una subida abandonada');

create or replace function private.is_valid_job_payload(p_kind text, p_payload jsonb)
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
    -- {"versionId": uuid}; the job's subject is the same version.
    when 'media.expire_abandoned_upload' then
      jsonb_typeof(p_payload) = 'object'
      and not exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'versionId')
      and coalesce(p_payload ->> 'versionId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    else false
  end;
$$;

-- Daily sweep: one job per image version still uploading after 24 h. Idempotent (the
-- logical key is the version), bounded per run. Returns how many jobs were created.
create function private.enqueue_abandoned_upload_jobs(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_version record;
  v_created integer := 0;
  v_new boolean;
begin
  for v_version in
    select v.id, v.tenant_id
    from public.asset_versions v
    where v.status = 'uploading' and v.created_at < now() - interval '24 hours'
      and not exists (
        select 1 from public.background_jobs j
        where j.tenant_id = v.tenant_id and j.kind = 'media.expire_abandoned_upload'
          and j.logical_key = 'asset_version:' || v.id::text
      )
    order by v.created_at
    limit greatest(least(coalesce(p_limit, 500), 5000), 1)
  loop
    select e.created into v_new
    from private.enqueue_job(
      v_version.tenant_id, 'media.expire_abandoned_upload', 'asset_version:' || v_version.id::text,
      jsonb_build_object('versionId', v_version.id), 'asset_version', v_version.id
    ) e;
    if v_new then
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end;
$$;

revoke all on function private.enqueue_abandoned_upload_jobs(integer) from public;

-- The version a job is about, checked against the job's own tenant (never the payload's).
create function private.job_asset_version(p_job public.background_jobs)
returns public.asset_versions
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_version public.asset_versions;
begin
  if p_job.subject_type is distinct from 'asset_version' then
    return null;
  end if;
  select * into v_version from public.asset_versions v
  where v.id = p_job.subject_id and v.tenant_id = p_job.tenant_id;
  return v_version;
end;
$$;

revoke all on function private.job_asset_version(public.background_jobs) from public;

-- worker_api: is the job's upload still abandoned, and where would its original be?
create function worker_api.abandoned_upload(p_job_id uuid, p_fencing_token bigint)
returns table (abandoned boolean, original_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'media.expire_abandoned_upload' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  v_version := private.job_asset_version(v_job);
  if v_version.id is null then
    return query select false, null::text;
    return;
  end if;
  return query select
    v_version.status = 'uploading' and v_version.created_at < now() - interval '24 hours',
    v_version.original_path;
end;
$$;

-- worker_api: the original was removed; mark the version rejected (once).
create function worker_api.mark_upload_abandoned(p_job_id uuid, p_fencing_token bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'media.expire_abandoned_upload' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  v_version := private.job_asset_version(v_job);
  if v_version.id is null then
    return 'not_found';
  end if;

  update public.asset_versions v
  set status = 'rejected', rejected_reason = 'Subida abandonada: nunca se confirmó.'
  where v.id = v_version.id and v.status = 'uploading'
    and v.created_at < now() - interval '24 hours';
  if not found then
    return 'already_settled';
  end if;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', v_job.tenant_id, null, 'media.upload_abandoned', 'asset_version', v_version.id,
    v_job.id, 'success', jsonb_build_object('assetId', v_version.asset_id, 'version', v_version.version)
  );
  return 'marked';
end;
$$;

revoke all on function worker_api.abandoned_upload(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function worker_api.mark_upload_abandoned(uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function worker_api.abandoned_upload(uuid, bigint) to rikuy_worker;
grant execute on function worker_api.mark_upload_abandoned(uuid, bigint) to rikuy_worker;

-- ── Schedules (the database is the clock) ──────────────────────────────────
-- Safety net for the trigger: due retries, expired leases, a kick that was lost.
select cron.schedule('rikuy-job-runner', '* * * * *', $$select private.kick_job_runner('schedule')$$);
-- Daily maintenance (07:17 UTC, 03:17 in Bolivia).
select cron.schedule('rikuy-expire-abandoned-uploads', '17 7 * * *', $$select private.enqueue_abandoned_upload_jobs()$$);
