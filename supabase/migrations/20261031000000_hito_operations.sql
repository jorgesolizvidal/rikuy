-- ★ Hito · Paso 3 — operation on free plans (ADR-035). Expand only.
--
-- 1. Operations snapshot: what the free plans can run out of (Storage of the whole project,
--    the database), the queue's health (failed jobs, work waiting) and the municipalities
--    close to a quota. Operators read it in /plataforma; the runner reads it once a day
--    (the database wakes it, like the queue) and emails the operators when something needs
--    a look.
-- 2. Unused photos and logos: every day, a photo or a logo that no destination, event, tour
--    point or brand version uses, ready for more than 7 days, is removed (its original and
--    its renditions) and its version rejected, which frees its quota. Panoramas and models
--    are never removed here. Public copies are always used by a sealed revision (which
--    «Volver a esta versión» needs), so they are never removed either.

-- ── 1. Plan limits and the operations snapshot ─────────────────────────────

-- The free plans' limits for the whole project (Supabase Free: 1 GB of Storage, 500 MB of
-- database). A paid plan changes them with a migration, like private.quota_default.
create function private.plan_limits()
returns table (storage_bytes bigint, database_bytes bigint)
language sql
immutable
set search_path = ''
as $$
  select 1073741824::bigint, 524288000::bigint;
$$;

revoke all on function private.plan_limits() from public;

create function private.operations_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'storage', jsonb_build_object(
      'bytes', (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o),
      'limit', (select l.storage_bytes from private.plan_limits() l)
    ),
    'database', jsonb_build_object(
      'bytes', pg_database_size(current_database()),
      'limit', (select l.database_bytes from private.plan_limits() l)
    ),
    'jobs', jsonb_build_object(
      'failed24h', (
        select count(*) from public.background_jobs j
        where j.status = 'dead_letter' and j.finished_at > now() - interval '24 hours'
      ),
      'waitingSeconds', (
        select coalesce(floor(extract(epoch from now() - min(j.available_at))), 0)::bigint
        from public.background_jobs j
        where j.status = 'pending' and j.available_at <= now()
      )
    ),
    -- Municipalities at 80 % or more of a quota in its current period.
    'quotas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenant', t.display_name, 'slug', t.slug, 'resource', r.resource,
               'used', coalesce(b.consumed, 0) + coalesce(b.reserved, 0),
               'limit', coalesce(b.limit_amount, private.quota_limit(t.id, r.resource)))
             order by t.display_name, r.resource)
      from public.tenants t
      cross join unnest(enum_range(null::public.usage_resource)) as r (resource)
      cross join lateral private.usage_period(t.id, r.resource) p
      left join public.usage_buckets b
        on b.tenant_id = t.id and b.resource = r.resource and b.period_start = p.period_start
      where t.status <> 'suspended'
        and coalesce(b.limit_amount, private.quota_limit(t.id, r.resource)) > 0
        and (coalesce(b.consumed, 0) + coalesce(b.reserved, 0)) * 5
            >= coalesce(b.limit_amount, private.quota_limit(t.id, r.resource)) * 4
    ), '[]'::jsonb),
    'unusedMedia', jsonb_build_object(
      'removed7d', (
        select count(*) from public.audit_events e
        where e.action = 'media.unused_removed' and e.occurred_at > now() - interval '7 days'
      ),
      'bytes7d', (
        select coalesce(sum((e.diff ->> 'bytes')::bigint), 0) from public.audit_events e
        where e.action = 'media.unused_removed' and e.occurred_at > now() - interval '7 days'
      )
    ),
    'at', now()
  );
$$;

revoke all on function private.operations_snapshot() from public;

-- Operators (second factor) see it in /plataforma.
create function public.platform_operations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  return private.operations_snapshot();
end;
$$;

revoke all on function public.platform_operations() from public, anon, authenticated;
grant execute on function public.platform_operations() to authenticated;

-- The runner's daily report: the snapshot and whom to tell (the active operators). Nothing
-- of any municipality's content, and no lease: it changes nothing.
create function worker_api.operations_report()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.operations_snapshot() || jsonb_build_object(
    'operators', coalesce((
      select jsonb_agg(u.email::text order by u.email)
      from public.platform_operators o
      join auth.users u on u.id = o.user_id
      where o.status = 'active' and u.email is not null
    ), '[]'::jsonb)
  );
$$;

revoke all on function worker_api.operations_report() from public, anon, authenticated, service_role;
grant execute on function worker_api.operations_report() to rikuy_worker;

-- Once a day the database asks the runner for the report (same address and secret as the
-- queue's wake-up, Supabase Vault). Not configured: nothing happens.
create function private.request_daily_report()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select s.decrypted_secret into v_url
  from vault.decrypted_secrets s where s.name = 'rikuy_job_runner_url';
  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s where s.name = 'rikuy_job_runner_secret';
  if v_url is null or v_secret is null or v_url !~ '^https?://' then
    return false;
  end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('reason', 'daily'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    timeout_milliseconds := 5000
  );
  return true;
end;
$$;

revoke all on function private.request_daily_report() from public;

-- ── 2. Unused photos and logos ─────────────────────────────────────────────

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values ('media.remove_unused', 'media', 5, 60, 120, 2, 'Limpieza de una imagen sin uso');

create or replace function private.is_valid_job_payload(p_kind text, p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    -- {"mode": "ok" | "fail_once" | "fail_always", "workMs": 0..10000}, both optional.
    when p_kind = 'system.probe' then
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
    when p_kind in ('media.expire_abandoned_upload', 'media.process_panorama', 'media.process_model',
                    'media.remove_unused') then
      jsonb_typeof(p_payload) = 'object'
      and not exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'versionId')
      and coalesce(p_payload ->> 'versionId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    -- {"membershipId": uuid}; the job's subject is the same membership. Never the address:
    -- the runner reads it under the job's lease.
    when p_kind = 'mail.membership_invitation' then
      jsonb_typeof(p_payload) = 'object'
      and not exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'membershipId')
      and coalesce(p_payload ->> 'membershipId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    else false
  end;
$$;

-- A photo or a logo nothing uses: no content revision (draft or sealed), no tour point and
-- no brand version (draft or sealed) references it, and it has been ready for 7 days (an
-- editor may still be about to save the draft that uses a fresh one).
create function private.is_unused_media(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.asset_versions v
    join public.assets a on a.id = v.asset_id and a.tenant_id = v.tenant_id
    where v.id = p_version_id
      and a.purpose in ('content', 'logo')
      and v.status = 'ready'
      and v.ready_at < now() - interval '7 days'
      and not exists (select 1 from public.media_references m where m.asset_version_id = v.id)
      and not exists (select 1 from public.tour_hotspot_images h where h.asset_version_id = v.id)
      and not exists (
        select 1 from public.tenant_config_versions c
        where c.tenant_id = v.tenant_id
          and c.branding #>> '{logo,assetId}' = v.asset_id::text
          and c.branding #>> '{logo,version}' = v.version::text
      )
  );
$$;

revoke all on function private.is_unused_media(uuid) from public;

-- Daily sweep: one job per unused version (idempotent, bounded per run).
create function private.enqueue_unused_media_jobs(p_limit integer default 500)
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
    join public.assets a on a.id = v.asset_id and a.tenant_id = v.tenant_id
    where a.purpose in ('content', 'logo') and v.status = 'ready'
      and v.ready_at < now() - interval '7 days'
      and private.is_unused_media(v.id)
      and not exists (
        select 1 from public.background_jobs j
        where j.tenant_id = v.tenant_id and j.kind = 'media.remove_unused'
          and j.logical_key = 'asset_version:' || v.id::text
      )
    order by v.ready_at
    limit greatest(least(coalesce(p_limit, 500), 5000), 1)
  loop
    select e.created into v_new
    from private.enqueue_job(
      v_version.tenant_id, 'media.remove_unused', 'asset_version:' || v_version.id::text,
      jsonb_build_object('versionId', v_version.id), 'asset_version', v_version.id
    ) e;
    if v_new then
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end;
$$;

revoke all on function private.enqueue_unused_media_jobs(integer) from public;

create function private.unused_media_reason()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Sin uso: se liberó su espacio.'::text;
$$;

revoke all on function private.unused_media_reason() from public;

-- worker_api: if the job's version is still unused, reject it now (nothing can start using
-- a rejected image) and hand back the folder whose files the runner removes. A retry after
-- the version was rejected by this cleanup hands the folder back again (removing is
-- idempotent); a version that is used again, or gone, hands back nothing.
create function worker_api.claim_unused_media(p_job_id uuid, p_fencing_token bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
  v_bytes bigint;
  v_prefix text;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'media.remove_unused' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  v_version := private.job_asset_version(v_job);
  if v_version.id is null then
    return null;
  end if;
  select * into v_version from public.asset_versions v where v.id = v_version.id for update;
  v_prefix := v_version.tenant_id::text || '/' || v_version.asset_id::text || '/' || v_version.version::text || '/';

  if v_version.status = 'rejected' and v_version.rejected_reason = private.unused_media_reason() then
    return v_prefix;
  end if;
  if not private.is_unused_media(v_version.id) then
    return null;
  end if;

  v_bytes := private.measure_version_bytes(v_version.id);
  update public.asset_versions v
  set status = 'rejected', rejected_reason = private.unused_media_reason()
  where v.id = v_version.id;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', v_job.tenant_id, null, 'media.unused_removed', 'asset_version', v_version.id,
    v_job.id, 'success',
    jsonb_build_object('assetId', v_version.asset_id, 'version', v_version.version, 'bytes', v_bytes)
  );
  return v_prefix;
end;
$$;

revoke all on function worker_api.claim_unused_media(uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function worker_api.claim_unused_media(uuid, bigint) to rikuy_worker;

-- ── Schedules ──────────────────────────────────────────────────────────────
-- 07:37 UTC (03:37 in Bolivia): the sweep. 11:07 UTC (07:07 in Bolivia): the report, after
-- the night's cleanups, at the start of the day.
select cron.schedule('rikuy-remove-unused-media', '37 7 * * *', $$select private.enqueue_unused_media_jobs()$$);
select cron.schedule('rikuy-daily-report', '7 11 * * *', $$select private.request_daily_report()$$);
