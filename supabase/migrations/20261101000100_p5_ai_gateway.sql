-- ─────────────────────────────────────────────────────────────────────────────
-- P5 · Paso 1 — AI gateway (ADR-036).
--
--   * rikuy_ai: the AI workload's own role (like rikuy_worker), NOLOGIN here; it can only
--     execute the ai_api schema. Neither the publishable nor the secret API key can reach
--     it, so no public path can spend a municipality's AI quota.
--   * ai_tokens: a daily quota per municipality (midnight in its time zone), 40,000 by
--     default, in the quota tables of ADR-027. A platform-wide cap per UTC day (180,000,
--     90 % of Groq's free plan) is checked after it.
--   * ai_requests / ai_executions: one row per request (reserved, then settled, or
--     rejected with its reason) and one per provider call. Never the text of a question or
--     an answer (ADR-022). A visitor is kept only as sha256(daily salt ‖ tenant ‖ key).
--   * The existing readers (tenant_usage, platform_tenant_usage, the operations snapshot's
--     quotas) keep returning storage and compute only: the deployed panel validates them
--     against a closed list. AI has readers of its own.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Workload role and its API schema ───────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rikuy_ai') then
    create role rikuy_ai nologin noinherit;
  end if;
end;
$$;

-- Lets migrations and pgTAP tests act as the AI workload (SET ROLE). PostgREST's
-- authenticator is NOT a member: no API key or JWT can switch to this role.
grant rikuy_ai to postgres;

create schema ai_api;
revoke all on schema ai_api from public;
grant usage on schema ai_api to rikuy_ai;

-- ── Quota: AI tokens per day ────────────────────────────────────────────────

create or replace function private.quota_default(p_resource public.usage_resource)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case p_resource
    when 'storage_bytes' then 314572800::bigint     -- 300 MB
    when 'media_compute_seconds' then 1800::bigint  -- 30 min per month
    when 'ai_tokens' then 40000::bigint             -- per day (ADR-036)
  end;
$$;

-- Storage has no period; compute counts per calendar month and AI per day, both in the
-- tenant's time zone.
create or replace function private.usage_period(
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
    case
      when p_resource = 'storage_bytes' then '-infinity'::timestamptz
      when p_resource = 'ai_tokens' then date_trunc('day', p_at at time zone t.timezone) at time zone t.timezone
      else date_trunc('month', p_at at time zone t.timezone) at time zone t.timezone
    end,
    case
      when p_resource = 'storage_bytes' then 'infinity'::timestamptz
      when p_resource = 'ai_tokens' then (date_trunc('day', p_at at time zone t.timezone) + interval '1 day') at time zone t.timezone
      else (date_trunc('month', p_at at time zone t.timezone) + interval '1 month') at time zone t.timezone
    end
  from public.tenants t
  where t.id = p_tenant_id;
$$;

-- The existing readers keep their contract: storage and compute only.
create or replace function public.tenant_usage(p_tenant_id uuid)
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
  where r.resource <> 'ai_tokens'
  order by r.resource;
end;
$$;

create or replace function public.platform_tenant_usage()
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
  where r.resource <> 'ai_tokens'
  order by t.display_name, r.resource;
end;
$$;

-- ── Tables ──────────────────────────────────────────────────────────────────

create table public.ai_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  profile         text not null,
  status          text not null,
  outcome         text not null,
  visitor_hash    text,
  actor_id        uuid references auth.users (id) on delete set null,
  reserved_tokens bigint not null default 0,
  input_tokens    bigint not null default 0,
  output_tokens   bigint not null default 0,
  latency_ms      integer,
  bucket_id       uuid,
  platform_day    date,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,

  constraint ai_requests_tenant_id_id_key unique (tenant_id, id),
  constraint ai_requests_bucket_fkey foreign key (tenant_id, bucket_id)
    references public.usage_buckets (tenant_id, id),
  constraint ai_requests_profile check (profile in ('assistant', 'copilot', 'probe')),
  constraint ai_requests_state check (
    (status = 'reserved' and outcome = 'pending'
      and bucket_id is not null and platform_day is not null and finished_at is null)
    or (status = 'rejected'
      and outcome in ('tenant_quota', 'platform_quota', 'visitor_limit', 'tenant_unavailable')
      and reserved_tokens = 0 and finished_at is not null)
    or (status = 'completed' and outcome = 'answered' and finished_at is not null)
    or (status = 'failed' and outcome in ('provider_unavailable', 'provider_error')
      and finished_at is not null)
    or (status = 'expired' and outcome = 'abandoned' and finished_at is not null)
  ),
  constraint ai_requests_visitor_hash check (visitor_hash is null or visitor_hash ~ '^[0-9a-f]{64}$'),
  constraint ai_requests_nonnegative check (
    reserved_tokens >= 0 and input_tokens >= 0 and output_tokens >= 0
    and (latency_ms is null or latency_ms >= 0)
  )
);

create index ai_requests_tenant_created_idx on public.ai_requests (tenant_id, created_at desc);
create index ai_requests_visitor_idx on public.ai_requests (tenant_id, visitor_hash, created_at)
  where visitor_hash is not null;
create index ai_requests_open_idx on public.ai_requests (created_at) where status = 'reserved';

create table public.ai_executions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  request_id    uuid not null,
  attempt       smallint not null,
  provider      text not null,
  model         text not null,
  status        text not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  latency_ms    integer not null default 0,
  http_status   smallint,
  created_at    timestamptz not null default now(),

  constraint ai_executions_request_fkey foreign key (tenant_id, request_id)
    references public.ai_requests (tenant_id, id) on delete cascade,
  constraint ai_executions_attempt_key unique (request_id, attempt),
  constraint ai_executions_attempt check (attempt between 1 and 3),
  constraint ai_executions_provider check (provider ~ '^[a-z0-9_-]{1,32}$'),
  constraint ai_executions_model check (model ~ '^[A-Za-z0-9._:/-]{1,100}$'),
  constraint ai_executions_status check (status in ('ok', 'rate_limited', 'timeout', 'unavailable', 'error')),
  constraint ai_executions_nonnegative check (input_tokens >= 0 and output_tokens >= 0 and latency_ms >= 0),
  constraint ai_executions_http_status check (http_status is null or http_status between 100 and 599)
);

-- The platform-wide cap per UTC day: what all municipalities together may use of the
-- provider's daily allowance.
create table public.ai_platform_days (
  day          date primary key,
  limit_tokens bigint not null,
  reserved     bigint not null default 0,
  consumed     bigint not null default 0,

  constraint ai_platform_days_nonnegative check (limit_tokens >= 0 and reserved >= 0 and consumed >= 0)
);

-- One random salt per UTC day for the visitors' keys; nobody can read it.
create table private.ai_visitor_salts (
  day  date primary key,
  salt text not null
);

alter table public.ai_requests enable row level security;
alter table public.ai_executions enable row level security;
alter table public.ai_platform_days enable row level security;
-- No policies and no grants: every read and write goes through the functions below.
revoke all on table public.ai_requests, public.ai_executions, public.ai_platform_days
  from public, anon, authenticated, service_role;
revoke all on table private.ai_visitor_salts from public;

-- ── Settings and helpers ────────────────────────────────────────────────────

-- 90 % of Groq's free plan (200,000 tokens per day for the whole organization).
create function private.ai_platform_daily_limit()
returns bigint
language sql
immutable
set search_path = ''
as $$ select 180000::bigint $$;

create function private.ai_visitor_hourly_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 10 $$;

create function private.ai_platform_day(p_at timestamptz default now())
returns date
language sql
stable
set search_path = ''
as $$ select (p_at at time zone 'UTC')::date $$;

-- sha256(today's salt ‖ tenant ‖ visitor key): the key itself is never stored, and keys of
-- different days or municipalities cannot be linked.
create function private.ai_visitor_hash(p_tenant_id uuid, p_visitor text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := private.ai_platform_day();
  v_salt text;
begin
  insert into private.ai_visitor_salts (day, salt)
  values (v_day, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (day) do nothing;
  select s.salt into v_salt from private.ai_visitor_salts s where s.day = v_day;
  return encode(
    sha256(convert_to(v_salt || ':' || p_tenant_id::text || ':' || p_visitor, 'UTF8')),
    'hex'
  );
end;
$$;

revoke all on function private.ai_platform_daily_limit() from public;
revoke all on function private.ai_visitor_hourly_limit() from public;
revoke all on function private.ai_platform_day(timestamptz) from public;
revoke all on function private.ai_visitor_hash(uuid, text) from public;

-- ── The workload's API ──────────────────────────────────────────────────────

-- Reserves p_reserve tokens for one request, or records why it cannot run (and reserves
-- nothing). Checks, in order: the municipality (suspended, or not online for the visitor
-- assistant), the visitor's hourly limit, the municipality's daily quota and the
-- platform's daily cap. Atomic: concurrent requests never pass a limit together.
create function ai_api.begin_request(
  p_tenant_id uuid,
  p_profile text,
  p_reserve bigint,
  p_visitor text default null,
  p_actor_id uuid default null
)
returns table (request_id uuid, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_status public.tenant_status;
  v_hash text;
  v_bucket uuid;
  v_day date := private.ai_platform_day();
  v_reason text;
  v_id uuid;
begin
  if p_profile is null or p_profile not in ('assistant', 'copilot', 'probe') then
    raise exception 'unknown AI profile' using errcode = '22023';
  end if;
  if p_reserve is null or p_reserve < 1 or p_reserve > 100000 then
    raise exception 'reservation out of range' using errcode = '22023';
  end if;
  if p_visitor is not null and (length(p_visitor) = 0 or length(p_visitor) > 200) then
    raise exception 'visitor key out of range' using errcode = '22023';
  end if;

  select t.status into v_status from public.tenants t where t.id = p_tenant_id;
  if not found then
    raise exception 'tenant not found' using errcode = 'PT404';
  end if;
  if p_visitor is not null then
    v_hash := private.ai_visitor_hash(p_tenant_id, p_visitor);
  end if;

  if v_status = 'suspended' or (p_profile = 'assistant' and v_status <> 'active') then
    v_reason := 'tenant_unavailable';
  elsif v_hash is not null then
    -- One visitor's requests line up, so two at once cannot both pass the limit.
    perform pg_advisory_xact_lock(hashtextextended(v_hash, 0));
    if (
      select count(*) from public.ai_requests r
      where r.tenant_id = p_tenant_id and r.visitor_hash = v_hash
        and r.status <> 'rejected' and r.created_at > now() - interval '1 hour'
    ) >= private.ai_visitor_hourly_limit() then
      v_reason := 'visitor_limit';
    end if;
  end if;

  if v_reason is null then
    v_bucket := private.current_usage_bucket(p_tenant_id, 'ai_tokens');
    -- The row locks serialize concurrent reservations, as for media (ADR-027).
    update public.usage_buckets b
    set reserved = b.reserved + p_reserve
    where b.id = v_bucket and b.consumed + b.reserved + p_reserve <= b.limit_amount;
    if not found then
      v_reason := 'tenant_quota';
    else
      insert into public.ai_platform_days (day, limit_tokens)
      values (v_day, private.ai_platform_daily_limit())
      on conflict (day) do nothing;
      update public.ai_platform_days d
      set reserved = d.reserved + p_reserve
      where d.day = v_day and d.consumed + d.reserved + p_reserve <= d.limit_tokens;
      if not found then
        update public.usage_buckets b
        set reserved = greatest(0, b.reserved - p_reserve)
        where b.id = v_bucket;
        v_reason := 'platform_quota';
      end if;
    end if;
  end if;

  if v_reason is not null then
    insert into public.ai_requests (tenant_id, profile, status, outcome, visitor_hash, actor_id, finished_at)
    values (p_tenant_id, p_profile, 'rejected', v_reason, v_hash, p_actor_id, now())
    returning id into v_id;
  else
    insert into public.ai_requests (
      tenant_id, profile, status, outcome, visitor_hash, actor_id, reserved_tokens, bucket_id, platform_day
    )
    values (p_tenant_id, p_profile, 'reserved', 'pending', v_hash, p_actor_id, p_reserve, v_bucket, v_day)
    returning id into v_id;
  end if;
  return query select v_id, coalesce(v_reason, 'reserved');
end;
$$;

-- Replaces a request's reservation by what its provider calls really used, and records
-- each call. Idempotent: a request already settled (or expired) is left as it is. Never
-- fails on a limit: the work already happened.
create function ai_api.finish_request(
  p_request_id uuid,
  p_outcome text,
  p_executions jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_requests;
  v_execution jsonb;
  v_attempt integer := 0;
  v_input bigint := 0;
  v_output bigint := 0;
  v_latency bigint := 0;
  v_used bigint;
begin
  if p_outcome is null or p_outcome not in ('answered', 'provider_unavailable', 'provider_error') then
    raise exception 'unknown outcome' using errcode = '22023';
  end if;
  if p_executions is null or jsonb_typeof(p_executions) <> 'array' or jsonb_array_length(p_executions) > 3 then
    raise exception 'executions must be an array of at most 3 calls' using errcode = '22023';
  end if;
  if p_outcome = 'answered' and jsonb_array_length(p_executions) = 0 then
    raise exception 'an answer needs the call that produced it' using errcode = '22023';
  end if;

  select * into v_request from public.ai_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'request not found' using errcode = 'PT404';
  end if;
  if v_request.status <> 'reserved' then
    return 'already_finished';
  end if;

  for v_execution in select value from jsonb_array_elements(p_executions) loop
    v_attempt := v_attempt + 1;
    insert into public.ai_executions (
      tenant_id, request_id, attempt, provider, model, status,
      input_tokens, output_tokens, latency_ms, http_status
    )
    values (
      v_request.tenant_id, v_request.id, v_attempt,
      v_execution ->> 'provider', v_execution ->> 'model', v_execution ->> 'status',
      coalesce((v_execution ->> 'inputTokens')::bigint, 0),
      coalesce((v_execution ->> 'outputTokens')::bigint, 0),
      coalesce((v_execution ->> 'latencyMs')::integer, 0),
      (v_execution ->> 'httpStatus')::smallint
    );
    v_input := v_input + coalesce((v_execution ->> 'inputTokens')::bigint, 0);
    v_output := v_output + coalesce((v_execution ->> 'outputTokens')::bigint, 0);
    v_latency := v_latency + coalesce((v_execution ->> 'latencyMs')::integer, 0);
  end loop;

  v_used := v_input + v_output;
  update public.usage_buckets b
  set reserved = greatest(0, b.reserved - v_request.reserved_tokens),
      consumed = b.consumed + v_used
  where b.tenant_id = v_request.tenant_id and b.id = v_request.bucket_id;
  update public.ai_platform_days d
  set reserved = greatest(0, d.reserved - v_request.reserved_tokens),
      consumed = d.consumed + v_used
  where d.day = v_request.platform_day;

  update public.ai_requests r
  set status = case when p_outcome = 'answered' then 'completed' else 'failed' end,
      outcome = p_outcome,
      input_tokens = v_input,
      output_tokens = v_output,
      latency_ms = least(v_latency, 2147483647)::integer,
      finished_at = now()
  where r.id = v_request.id;
  return 'settled';
end;
$$;

revoke all on function ai_api.begin_request(uuid, text, bigint, text, uuid) from public;
revoke all on function ai_api.finish_request(uuid, text, jsonb) from public;
grant execute on function ai_api.begin_request(uuid, text, bigint, text, uuid) to rikuy_ai;
grant execute on function ai_api.finish_request(uuid, text, jsonb) to rikuy_ai;

-- ── Orphan reservations and retention ───────────────────────────────────────

-- A request still reserved after 10 minutes lost its server (it never takes that long):
-- its reservation counts as used, since the provider may have spent it. Also drops what is
-- no longer needed: requests after 90 days, salts after 2 days, platform days after 90.
create function private.expire_ai_requests()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_requests;
  v_count integer := 0;
begin
  for v_request in
    select * from public.ai_requests r
    where r.status = 'reserved' and r.created_at < now() - interval '10 minutes'
    for update skip locked
  loop
    update public.usage_buckets b
    set reserved = greatest(0, b.reserved - v_request.reserved_tokens),
        consumed = b.consumed + v_request.reserved_tokens
    where b.tenant_id = v_request.tenant_id and b.id = v_request.bucket_id;
    update public.ai_platform_days d
    set reserved = greatest(0, d.reserved - v_request.reserved_tokens),
        consumed = d.consumed + v_request.reserved_tokens
    where d.day = v_request.platform_day;
    update public.ai_requests r
    set status = 'expired', outcome = 'abandoned', finished_at = now()
    where r.id = v_request.id;
    v_count := v_count + 1;
  end loop;

  delete from public.ai_requests r where r.created_at < now() - interval '90 days';
  delete from private.ai_visitor_salts s where s.day < private.ai_platform_day() - 2;
  delete from public.ai_platform_days d where d.day < private.ai_platform_day() - 90;
  return v_count;
end;
$$;

revoke all on function private.expire_ai_requests() from public;

select cron.schedule('rikuy-expire-ai-requests', '*/15 * * * *', $$select private.expire_ai_requests()$$);

-- ── Reading: the municipality and the platform ──────────────────────────────

-- The municipality's AI usage today (any member), without creating buckets.
create function public.tenant_ai_usage(p_tenant_id uuid)
returns table (
  limit_amount   bigint,
  reserved       bigint,
  consumed       bigint,
  period_start   timestamptz,
  period_end     timestamptz,
  answered_today bigint,
  refused_today  bigint
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
  select coalesce(b.limit_amount, private.quota_limit(p_tenant_id, 'ai_tokens')),
         coalesce(b.reserved, 0), coalesce(b.consumed, 0), p.period_start, p.period_end,
         (select count(*) from public.ai_requests r
          where r.tenant_id = p_tenant_id and r.outcome = 'answered' and r.created_at >= p.period_start),
         (select count(*) from public.ai_requests r
          where r.tenant_id = p_tenant_id and r.status = 'rejected' and r.created_at >= p.period_start)
  from private.usage_period(p_tenant_id, 'ai_tokens') p
  left join public.usage_buckets b
    on b.tenant_id = p_tenant_id and b.resource = 'ai_tokens' and b.period_start = p.period_start;
end;
$$;

-- Every municipality's AI usage today, for the platform operator (second factor).
create function public.platform_ai_usage()
returns table (
  tenant_id      uuid,
  slug           text,
  display_name   text,
  status         public.tenant_status,
  limit_amount   bigint,
  is_default     boolean,
  reserved       bigint,
  consumed       bigint,
  period_start   timestamptz,
  period_end     timestamptz,
  answered_today bigint,
  refused_today  bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  return query
  select t.id, t.slug, t.display_name, t.status,
         coalesce(b.limit_amount, private.quota_limit(t.id, 'ai_tokens')),
         not exists (select 1 from public.tenant_quotas q where q.tenant_id = t.id and q.resource = 'ai_tokens'),
         coalesce(b.reserved, 0), coalesce(b.consumed, 0), p.period_start, p.period_end,
         (select count(*) from public.ai_requests r
          where r.tenant_id = t.id and r.outcome = 'answered' and r.created_at >= p.period_start),
         (select count(*) from public.ai_requests r
          where r.tenant_id = t.id and r.status = 'rejected' and r.created_at >= p.period_start)
  from public.tenants t
  cross join lateral private.usage_period(t.id, 'ai_tokens') p
  left join public.usage_buckets b
    on b.tenant_id = t.id and b.resource = 'ai_tokens' and b.period_start = p.period_start
  order by t.display_name;
end;
$$;

revoke all on function public.tenant_ai_usage(uuid) from public, anon, authenticated;
revoke all on function public.platform_ai_usage() from public, anon, authenticated;
grant execute on function public.tenant_ai_usage(uuid) to authenticated;
grant execute on function public.platform_ai_usage() to authenticated;

-- ── Operations snapshot (ADR-035): AI under its own key ─────────────────────

create or replace function private.operations_snapshot()
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
    -- Municipalities at 80 % or more of a storage or compute quota in its current period.
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
        and r.resource <> 'ai_tokens'
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
    -- AI (ADR-036): today's platform cap (UTC), the last 24 hours and the municipalities at
    -- 80 % or more of their daily AI quota.
    'ai', jsonb_build_object(
      'used', coalesce((
        select d.consumed + d.reserved from public.ai_platform_days d
        where d.day = private.ai_platform_day()
      ), 0),
      'limit', coalesce((
        select d.limit_tokens from public.ai_platform_days d
        where d.day = private.ai_platform_day()
      ), private.ai_platform_daily_limit()),
      'answered24h', (
        select count(*) from public.ai_requests r
        where r.outcome = 'answered' and r.created_at > now() - interval '24 hours'
      ),
      'refused24h', (
        select count(*) from public.ai_requests r
        where r.status = 'rejected' and r.created_at > now() - interval '24 hours'
      ),
      'failed24h', (
        select count(*) from public.ai_requests r
        where r.status in ('failed', 'expired') and r.created_at > now() - interval '24 hours'
      ),
      'quotas', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'tenant', t.display_name, 'slug', t.slug,
                 'used', coalesce(b.consumed, 0) + coalesce(b.reserved, 0),
                 'limit', coalesce(b.limit_amount, private.quota_limit(t.id, 'ai_tokens')))
               order by t.display_name)
        from public.tenants t
        cross join lateral private.usage_period(t.id, 'ai_tokens') p
        left join public.usage_buckets b
          on b.tenant_id = t.id and b.resource = 'ai_tokens' and b.period_start = p.period_start
        where t.status <> 'suspended'
          and coalesce(b.limit_amount, private.quota_limit(t.id, 'ai_tokens')) > 0
          and (coalesce(b.consumed, 0) + coalesce(b.reserved, 0)) * 5
              >= coalesce(b.limit_amount, private.quota_limit(t.id, 'ai_tokens')) * 4
      ), '[]'::jsonb)
    ),
    'at', now()
  );
$$;
