-- ─────────────────────────────────────────────────────────────────────────────
-- P2 · Paso 5: quotas per municipality (ADR-012; schema 11 «usage_buckets»).
--
--   * Two resources:
--       storage_bytes          — what the municipality's media take up in Storage: originals
--                                plus derivatives (both buckets), with no period;
--       media_compute_seconds  — processing time of panoramas and 3D models, per calendar
--                                month in the municipality's own time zone.
--   * Limits: platform defaults (300 MB, 30 min/month), changed per municipality only by a
--     platform operator (with a second factor). Nobody raises their own quota.
--   * Atomic reservation: requesting an upload reserves an estimate (×1.5 the declared size
--     for photos and logos, ×2 for panoramas and models, plus 240 s of compute for each
--     panorama or model) with one conditional UPDATE on the bucket row. Concurrent requests
--     wait on that row, so together they can never pass the limit.
--   * Settlement: when a version is ready (or published, or gets its poster) the database
--     measures its real bytes in storage.objects; when it is rejected, the reservation is
--     released. When a media job finishes, its compute is settled from its attempts.
--   * Settlement may overshoot the limit (the work already happened); the next reservation
--     is then refused. Hooked with triggers on the tables whose state already changes, so
--     the existing functions keep their contract. Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.usage_resource as enum ('storage_bytes', 'media_compute_seconds');

-- What an operator assigned to one municipality (absent → platform default).
create table public.tenant_quotas (
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  resource     public.usage_resource not null,
  limit_amount bigint not null,
  updated_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),

  primary key (tenant_id, resource),
  constraint tenant_quotas_limit_range check (limit_amount between 0 and 1099511627776)
);

create table public.usage_buckets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  resource     public.usage_resource not null,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  limit_amount bigint not null,
  reserved     bigint not null default 0,
  consumed     bigint not null default 0,
  created_at   timestamptz not null default now(),

  constraint usage_buckets_tenant_id_id_key unique (tenant_id, id),
  constraint usage_buckets_period_key unique (tenant_id, resource, period_start),
  constraint usage_buckets_period_order check (period_start < period_end),
  constraint usage_buckets_nonnegative check (limit_amount >= 0 and reserved >= 0 and consumed >= 0)
);

-- One reservation per resource and media version: what was set aside and what was used.
create table public.usage_reservations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  bucket_id        uuid not null,
  resource         public.usage_resource not null,
  asset_version_id uuid not null,
  reserved         bigint not null default 0,
  consumed         bigint not null default 0,
  status           text not null default 'open',
  created_at       timestamptz not null default now(),
  settled_at       timestamptz,

  constraint usage_reservations_subject_key unique (resource, asset_version_id),
  constraint usage_reservations_bucket_fkey foreign key (tenant_id, bucket_id)
    references public.usage_buckets (tenant_id, id) on delete cascade,
  constraint usage_reservations_version_fkey foreign key (tenant_id, asset_version_id)
    references public.asset_versions (tenant_id, id) on delete cascade,
  constraint usage_reservations_status check (status in ('open', 'settled', 'released')),
  constraint usage_reservations_nonnegative check (reserved >= 0 and consumed >= 0)
);

create index usage_reservations_bucket_idx on public.usage_reservations (tenant_id, bucket_id);

alter table public.tenant_quotas enable row level security;
alter table public.usage_buckets enable row level security;
alter table public.usage_reservations enable row level security;
-- No policies and no grants: every read and write goes through the functions below.
revoke all on table public.tenant_quotas, public.usage_buckets, public.usage_reservations
  from public, anon, authenticated, service_role;

-- ── Defaults, periods and buckets ───────────────────────────────────────────

create function private.quota_default(p_resource public.usage_resource)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case p_resource
    when 'storage_bytes' then 314572800::bigint     -- 300 MB
    when 'media_compute_seconds' then 1800::bigint  -- 30 min per month
  end;
$$;

create function private.quota_limit(p_tenant_id uuid, p_resource public.usage_resource)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select q.limit_amount from public.tenant_quotas q
     where q.tenant_id = p_tenant_id and q.resource = p_resource),
    private.quota_default(p_resource)
  );
$$;

-- Storage has no period; compute counts per calendar month in the tenant's time zone.
create function private.usage_period(
  p_tenant_id uuid,
  p_resource public.usage_resource,
  p_at timestamptz default now()
)
returns table (period_start timestamptz, period_end timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case when p_resource = 'storage_bytes' then '-infinity'::timestamptz
      else date_trunc('month', p_at at time zone t.timezone) at time zone t.timezone end,
    case when p_resource = 'storage_bytes' then 'infinity'::timestamptz
      else (date_trunc('month', p_at at time zone t.timezone) + interval '1 month') at time zone t.timezone end
  from public.tenants t
  where t.id = p_tenant_id;
$$;

-- The current bucket, created on first use with the tenant's limit at that moment.
create function private.current_usage_bucket(p_tenant_id uuid, p_resource public.usage_resource)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_id uuid;
begin
  select p.period_start, p.period_end into v_start, v_end
  from private.usage_period(p_tenant_id, p_resource) p;
  if v_start is null then
    raise exception 'unknown tenant' using errcode = 'PT404';
  end if;
  insert into public.usage_buckets (tenant_id, resource, period_start, period_end, limit_amount)
  values (p_tenant_id, p_resource, v_start, v_end, private.quota_limit(p_tenant_id, p_resource))
  on conflict (tenant_id, resource, period_start) do nothing;
  select b.id into v_id from public.usage_buckets b
  where b.tenant_id = p_tenant_id and b.resource = p_resource and b.period_start = v_start;
  return v_id;
end;
$$;

-- ── Reservation (atomic) ────────────────────────────────────────────────────

-- PT507 (hint: the resource) when the reservation would pass the limit.
create function private.reserve_usage(
  p_tenant_id uuid,
  p_resource public.usage_resource,
  p_version_id uuid,
  p_amount bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bucket uuid := private.current_usage_bucket(p_tenant_id, p_resource);
begin
  if p_amount <= 0 then
    return;
  end if;
  -- The row lock serializes concurrent reservations; each re-checks the limit after the
  -- previous one committed, so together they never pass it.
  update public.usage_buckets b
  set reserved = b.reserved + p_amount
  where b.id = v_bucket and b.consumed + b.reserved + p_amount <= b.limit_amount;
  if not found then
    raise exception 'quota exceeded' using errcode = 'PT507', hint = p_resource::text;
  end if;
  insert into public.usage_reservations (tenant_id, bucket_id, resource, asset_version_id, reserved)
  values (p_tenant_id, v_bucket, p_resource, p_version_id, p_amount);
end;
$$;

-- Replaces what a reservation holds by what was really used (idempotent: run it again and
-- only the difference moves). Never fails on the limit: the work already happened.
create function private.settle_usage(
  p_resource public.usage_resource,
  p_version_id uuid,
  p_consumed bigint,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.usage_reservations;
begin
  select * into v_reservation from public.usage_reservations r
  where r.resource = p_resource and r.asset_version_id = p_version_id
  for update;
  if not found then
    return; -- A version from before quotas, or never reserved (seed data).
  end if;
  update public.usage_buckets b
  set reserved = greatest(0, b.reserved - v_reservation.reserved),
      consumed = greatest(0, b.consumed + greatest(0, p_consumed) - v_reservation.consumed)
  where b.id = v_reservation.bucket_id;
  update public.usage_reservations r
  set reserved = 0, consumed = greatest(0, p_consumed), status = p_status, settled_at = now()
  where r.id = v_reservation.id;
end;
$$;

-- Bytes of one media version in Storage (both buckets), but for the GLB pipeline's
-- intermediate textures, which it removes right after finishing.
create function private.measure_version_bytes(p_version_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from public.asset_versions v
  join storage.objects o
    on o.bucket_id in ('media-originals', 'media-public')
   and o.name like v.tenant_id::text || '/' || v.asset_id::text || '/' || v.version::text || '/%'
   and o.name not like '%/model/work/%'
  where v.id = p_version_id;
$$;

-- ── Hooks on media versions ─────────────────────────────────────────────────

-- A requested upload reserves its estimate (the INSERT fails, and with it the request, when
-- the quota cannot hold it).
create function private.reserve_media_upload()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purpose public.asset_purpose;
begin
  if new.status <> 'uploading' then
    return null;
  end if;
  select a.purpose into v_purpose from public.assets a
  where a.tenant_id = new.tenant_id and a.id = new.asset_id;
  perform private.reserve_usage(
    new.tenant_id, 'storage_bytes', new.id,
    ceil(new.declared_bytes * case when v_purpose in ('panorama', 'model') then 2 else 1.5 end)::bigint
  );
  if v_purpose in ('panorama', 'model') then
    perform private.reserve_usage(
      new.tenant_id, 'media_compute_seconds', new.id,
      (select k.max_active_seconds::bigint from public.job_kinds k
       where k.kind = case when v_purpose = 'panorama' then 'media.process_panorama' else 'media.process_model' end)
    );
  end if;
  return null;
end;
$$;

create trigger asset_versions_reserve_usage
  after insert on public.asset_versions
  for each row execute function private.reserve_media_upload();

-- Ready, published or poster added → measure; rejected → nothing is kept.
create function private.settle_media_storage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'rejected' and old.status <> 'rejected' then
    perform private.settle_usage('storage_bytes', new.id, 0, 'released');
    -- No processing job will ever settle the compute of an upload that never got one.
    if not exists (
      select 1 from public.background_jobs j
      where j.tenant_id = new.tenant_id and j.subject_type = 'asset_version' and j.subject_id = new.id
        and j.kind in ('media.process_panorama', 'media.process_model')
    ) then
      perform private.settle_usage('media_compute_seconds', new.id, 0, 'released');
    end if;
  elsif new.status = 'ready' and (
    old.status <> 'ready'
    or new.published_at is distinct from old.published_at
    or new.manifest is distinct from old.manifest
  ) then
    perform private.settle_usage('storage_bytes', new.id, private.measure_version_bytes(new.id), 'settled');
  end if;
  return null;
end;
$$;

create trigger asset_versions_settle_usage
  after update of status, published_at, manifest on public.asset_versions
  for each row execute function private.settle_media_storage();

-- ── Hooks on media jobs ─────────────────────────────────────────────────────

-- A finished panorama or model job settles the compute of its version: the time of all its
-- attempts (an operator replay adds its new attempts).
create function private.settle_media_compute()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind not in ('media.process_panorama', 'media.process_model')
     or new.subject_type is distinct from 'asset_version'
     or new.status not in ('succeeded', 'dead_letter')
     or new.status = old.status then
    return null;
  end if;
  perform private.settle_usage(
    'media_compute_seconds', new.subject_id,
    (select coalesce(ceil(sum(extract(epoch from coalesce(a.finished_at, now()) - a.started_at))), 0)::bigint
     from public.job_attempts a where a.job_id = new.id),
    'settled'
  );
  return null;
end;
$$;

create trigger background_jobs_settle_usage
  after update of status on public.background_jobs
  for each row execute function private.settle_media_compute();

revoke all on function private.quota_default(public.usage_resource) from public;
revoke all on function private.quota_limit(uuid, public.usage_resource) from public;
revoke all on function private.usage_period(uuid, public.usage_resource, timestamptz) from public;
revoke all on function private.current_usage_bucket(uuid, public.usage_resource) from public;
revoke all on function private.reserve_usage(uuid, public.usage_resource, uuid, bigint) from public;
revoke all on function private.settle_usage(public.usage_resource, uuid, bigint, text) from public;
revoke all on function private.measure_version_bytes(uuid) from public;
revoke all on function private.reserve_media_upload() from public;
revoke all on function private.settle_media_storage() from public;
revoke all on function private.settle_media_compute() from public;

-- ── Reading: the municipality and the platform ──────────────────────────────

-- The current usage of a municipality (any member), without creating buckets.
create function public.tenant_usage(p_tenant_id uuid)
returns table (
  resource     public.usage_resource,
  limit_amount bigint,
  reserved     bigint,
  consumed     bigint,
  period_start timestamptz,
  period_end   timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  return query
  select r.resource, coalesce(b.limit_amount, private.quota_limit(p_tenant_id, r.resource)),
         coalesce(b.reserved, 0), coalesce(b.consumed, 0), p.period_start, p.period_end
  from unnest(enum_range(null::public.usage_resource)) as r (resource)
  cross join lateral private.usage_period(p_tenant_id, r.resource) p
  left join public.usage_buckets b
    on b.tenant_id = p_tenant_id and b.resource = r.resource and b.period_start = p.period_start
  order by r.resource;
end;
$$;

-- Every municipality's usage, for the platform operator (second factor).
create function public.platform_tenant_usage()
returns table (
  tenant_id    uuid,
  slug         text,
  display_name text,
  resource     public.usage_resource,
  limit_amount bigint,
  is_default   boolean,
  reserved     bigint,
  consumed     bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  return query
  select t.id, t.slug, t.display_name, r.resource,
         coalesce(b.limit_amount, private.quota_limit(t.id, r.resource)),
         not exists (select 1 from public.tenant_quotas q where q.tenant_id = t.id and q.resource = r.resource),
         coalesce(b.reserved, 0), coalesce(b.consumed, 0)
  from public.tenants t
  cross join unnest(enum_range(null::public.usage_resource)) as r (resource)
  cross join lateral private.usage_period(t.id, r.resource) p
  left join public.usage_buckets b
    on b.tenant_id = t.id and b.resource = r.resource and b.period_start = p.period_start
  order by t.display_name, r.resource;
end;
$$;

-- An operator changes a municipality's limit (also for the current period). Lowering it
-- below what is used does not delete anything: new uploads are refused until there is room.
create function public.platform_set_quota(
  p_tenant_id uuid,
  p_resource public.usage_resource,
  p_limit bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous bigint;
begin
  perform private.assert_platform_actor();
  if p_limit is null or p_limit < 0 or p_limit > 1099511627776 then
    raise exception 'limit out of range' using errcode = '23514';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'tenant not found' using errcode = 'PT404';
  end if;
  v_previous := private.quota_limit(p_tenant_id, p_resource);

  insert into public.tenant_quotas (tenant_id, resource, limit_amount, updated_by)
  values (p_tenant_id, p_resource, p_limit, (select auth.uid()))
  on conflict (tenant_id, resource) do update
    set limit_amount = excluded.limit_amount, updated_by = excluded.updated_by, updated_at = now();
  update public.usage_buckets b
  set limit_amount = p_limit
  where b.id = private.current_usage_bucket(p_tenant_id, p_resource);

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff
  )
  values (
    'tenant', p_tenant_id, (select auth.uid()), 'platform.quota_changed', 'tenant', p_tenant_id,
    'success', jsonb_build_object('resource', p_resource, 'from', v_previous, 'to', p_limit)
  );
end;
$$;

revoke all on function public.tenant_usage(uuid) from public, anon, authenticated;
revoke all on function public.platform_tenant_usage() from public, anon, authenticated;
revoke all on function public.platform_set_quota(uuid, public.usage_resource, bigint) from public, anon, authenticated;
grant execute on function public.tenant_usage(uuid) to authenticated;
grant execute on function public.platform_tenant_usage() to authenticated;
grant execute on function public.platform_set_quota(uuid, public.usage_resource, bigint) to authenticated;

-- ── Media that existed before quotas ────────────────────────────────────────
-- Ready versions are measured and counted; versions still uploading or processing get an
-- empty reservation, so their settlement (ready or rejected, job finished) counts them.
-- Compute used before this migration is not counted.
do $$
declare
  v record;
  v_bucket uuid;
  v_bytes bigint;
begin
  for v in
    select av.id, av.tenant_id, av.status, a.purpose
    from public.asset_versions av
    join public.assets a on a.tenant_id = av.tenant_id and a.id = av.asset_id
    where av.status <> 'rejected'
  loop
    v_bucket := private.current_usage_bucket(v.tenant_id, 'storage_bytes');
    if v.status = 'ready' then
      v_bytes := private.measure_version_bytes(v.id);
      insert into public.usage_reservations (tenant_id, bucket_id, resource, asset_version_id, consumed, status, settled_at)
      values (v.tenant_id, v_bucket, 'storage_bytes', v.id, v_bytes, 'settled', now());
      update public.usage_buckets b set consumed = b.consumed + v_bytes where b.id = v_bucket;
    else
      insert into public.usage_reservations (tenant_id, bucket_id, resource, asset_version_id)
      values (v.tenant_id, v_bucket, 'storage_bytes', v.id);
      if v.purpose in ('panorama', 'model') then
        insert into public.usage_reservations (tenant_id, bucket_id, resource, asset_version_id)
        values (v.tenant_id, private.current_usage_bucket(v.tenant_id, 'media_compute_seconds'),
                'media_compute_seconds', v.id);
      end if;
    end if;
  end loop;
end;
$$;
