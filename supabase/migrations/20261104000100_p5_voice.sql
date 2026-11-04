-- ─────────────────────────────────────────────────────────────────────────────
-- P5 · Paso 6 — dictation for the visitor's assistant (ADR-041).
--
--   * ai_audio_seconds: a daily quota per municipality (midnight in its time zone), 1,800 s
--     by default, in the quota tables of ADR-027. A platform-wide cap per UTC day (25,900 s,
--     90 % of Groq's free plan for speech: 28,800 audio seconds a day) is checked after it.
--   * A dictation is an ai_requests row of its own profile («dictation»): it reserves the
--     longest recording (30 s), and settles with the seconds the provider bills (at least
--     10 s per transcription). Never the audio or the text (ADR-022).
--   * Each visitor may dictate 10 times per hour, apart from the 10 questions per hour of
--     the assistant: a dictated question also counts as a question when it is sent.
--   * The existing readers keep their contract: tenant_usage, platform_tenant_usage and the
--     operations snapshot's quotas return storage and compute only; the AI readers count
--     only the assistant's requests. Voice has readers of its own.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Quota: audio seconds per day ────────────────────────────────────────────

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
    when 'ai_audio_seconds' then 1800::bigint       -- 30 min of dictation per day (ADR-041)
  end;
$$;

-- Storage has no period; compute counts per calendar month; AI tokens and audio seconds
-- per day, all in the tenant's time zone.
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
      when p_resource in ('ai_tokens', 'ai_audio_seconds')
        then date_trunc('day', p_at at time zone t.timezone) at time zone t.timezone
      else date_trunc('month', p_at at time zone t.timezone) at time zone t.timezone
    end,
    case
      when p_resource = 'storage_bytes' then 'infinity'::timestamptz
      when p_resource in ('ai_tokens', 'ai_audio_seconds')
        then (date_trunc('day', p_at at time zone t.timezone) + interval '1 day') at time zone t.timezone
      else (date_trunc('month', p_at at time zone t.timezone) + interval '1 month') at time zone t.timezone
    end
  from public.tenants t
  where t.id = p_tenant_id;
$$;

-- The existing readers keep their contract: storage and compute only (named, so a future
-- resource never reaches a panel that does not know it).
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
  from unnest(array['storage_bytes', 'media_compute_seconds']::public.usage_resource[]) as r (resource)
  cross join lateral private.usage_period(p_tenant_id, r.resource) p
  left join public.usage_buckets b
    on b.tenant_id = p_tenant_id and b.resource = r.resource and b.period_start = p.period_start
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
  cross join unnest(array['storage_bytes', 'media_compute_seconds']::public.usage_resource[]) as r (resource)
  cross join lateral private.usage_period(t.id, r.resource) p
  left join public.usage_buckets b
    on b.tenant_id = t.id and b.resource = r.resource and b.period_start = p.period_start
  order by t.display_name, r.resource;
end;
$$;

-- ── Tables ──────────────────────────────────────────────────────────────────

alter table public.ai_requests
  add column reserved_seconds bigint not null default 0,
  add column audio_seconds bigint not null default 0;

alter table public.ai_requests drop constraint ai_requests_profile;
alter table public.ai_requests add constraint ai_requests_profile
  check (profile in ('assistant', 'copilot', 'probe', 'dictation'));

alter table public.ai_requests drop constraint ai_requests_state;
alter table public.ai_requests add constraint ai_requests_state check (
  (status = 'reserved' and outcome = 'pending'
    and bucket_id is not null and platform_day is not null and finished_at is null)
  or (status = 'rejected'
    and outcome in ('tenant_quota', 'platform_quota', 'visitor_limit', 'tenant_unavailable')
    and reserved_tokens = 0 and reserved_seconds = 0 and finished_at is not null)
  or (status = 'completed' and finished_at is not null
    and outcome = case when profile = 'dictation' then 'transcribed' else 'answered' end)
  or (status = 'failed' and outcome in ('provider_unavailable', 'provider_error')
    and finished_at is not null)
  or (status = 'expired' and outcome = 'abandoned' and finished_at is not null)
);

-- A dictation counts seconds and no tokens; every other profile, tokens and no seconds.
alter table public.ai_requests add constraint ai_requests_amounts check (
  case when profile = 'dictation'
    then reserved_tokens = 0 and input_tokens = 0 and output_tokens = 0
    else reserved_seconds = 0 and audio_seconds = 0
  end
  and reserved_seconds >= 0 and audio_seconds >= 0
);

alter table public.ai_executions
  add column audio_seconds bigint not null default 0;
alter table public.ai_executions add constraint ai_executions_audio_seconds
  check (audio_seconds between 0 and 600);

-- The platform's daily share of the provider's speech allowance, next to its tokens.
alter table public.ai_platform_days
  add column limit_audio_seconds bigint not null default 25900,
  add column audio_reserved bigint not null default 0,
  add column audio_consumed bigint not null default 0;
alter table public.ai_platform_days add constraint ai_platform_days_audio_nonnegative
  check (limit_audio_seconds >= 0 and audio_reserved >= 0 and audio_consumed >= 0);

-- ── Settings ────────────────────────────────────────────────────────────────

-- 90 % of Groq's free plan for speech (28,800 audio seconds per day for the organization).
create function private.ai_platform_audio_daily_limit()
returns bigint
language sql
immutable
set search_path = ''
as $$ select 25900::bigint $$;

create function private.ai_visitor_dictation_hourly_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 10 $$;

revoke all on function private.ai_platform_audio_daily_limit() from public;
revoke all on function private.ai_visitor_dictation_hourly_limit() from public;

-- ── The workload's API: the assistant's requests leave dictations alone ─────

-- As in ADR-036, but a visitor's dictations do not count against their questions.
create or replace function ai_api.begin_request(
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
      where r.tenant_id = p_tenant_id and r.visitor_hash = v_hash and r.profile <> 'dictation'
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

-- As in ADR-036; a dictation is settled by finish_dictation (seconds, not tokens).
create or replace function ai_api.finish_request(
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
  if v_request.profile = 'dictation' then
    raise exception 'a dictation is settled in seconds' using errcode = '22023';
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

-- ── The workload's API: dictation ───────────────────────────────────────────

-- Reserves p_reserve_seconds of audio for one dictation of the visitor's assistant, or
-- records why it cannot run (and reserves nothing). Checks, in order: the municipality
-- (online), the visitor's dictations in the last hour, the municipality's daily seconds and
-- the platform's. Atomic, like begin_request.
create function ai_api.begin_dictation(
  p_tenant_id uuid,
  p_reserve_seconds integer,
  p_visitor text default null
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
  -- The provider bills at least 10 s; the longest recording is 30 s (ADR-041).
  if p_reserve_seconds is null or p_reserve_seconds < 10 or p_reserve_seconds > 60 then
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

  if v_status <> 'active' then
    v_reason := 'tenant_unavailable';
  elsif v_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_hash, 1));
    if (
      select count(*) from public.ai_requests r
      where r.tenant_id = p_tenant_id and r.visitor_hash = v_hash and r.profile = 'dictation'
        and r.status <> 'rejected' and r.created_at > now() - interval '1 hour'
    ) >= private.ai_visitor_dictation_hourly_limit() then
      v_reason := 'visitor_limit';
    end if;
  end if;

  if v_reason is null then
    v_bucket := private.current_usage_bucket(p_tenant_id, 'ai_audio_seconds');
    update public.usage_buckets b
    set reserved = b.reserved + p_reserve_seconds
    where b.id = v_bucket and b.consumed + b.reserved + p_reserve_seconds <= b.limit_amount;
    if not found then
      v_reason := 'tenant_quota';
    else
      insert into public.ai_platform_days (day, limit_tokens, limit_audio_seconds)
      values (v_day, private.ai_platform_daily_limit(), private.ai_platform_audio_daily_limit())
      on conflict (day) do nothing;
      update public.ai_platform_days d
      set audio_reserved = d.audio_reserved + p_reserve_seconds
      where d.day = v_day
        and d.audio_consumed + d.audio_reserved + p_reserve_seconds <= d.limit_audio_seconds;
      if not found then
        update public.usage_buckets b
        set reserved = greatest(0, b.reserved - p_reserve_seconds)
        where b.id = v_bucket;
        v_reason := 'platform_quota';
      end if;
    end if;
  end if;

  if v_reason is not null then
    insert into public.ai_requests (tenant_id, profile, status, outcome, visitor_hash, finished_at)
    values (p_tenant_id, 'dictation', 'rejected', v_reason, v_hash, now())
    returning id into v_id;
  else
    insert into public.ai_requests (
      tenant_id, profile, status, outcome, visitor_hash, reserved_seconds, bucket_id, platform_day
    )
    values (p_tenant_id, 'dictation', 'reserved', 'pending', v_hash, p_reserve_seconds, v_bucket, v_day)
    returning id into v_id;
  end if;
  return query select v_id, coalesce(v_reason, 'reserved');
end;
$$;

-- Replaces a dictation's reservation by the seconds its provider calls billed, and records
-- each call. Idempotent, and never fails on a limit (the work already happened).
create function ai_api.finish_dictation(
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
  v_seconds bigint := 0;
  v_latency bigint := 0;
begin
  if p_outcome is null or p_outcome not in ('transcribed', 'provider_unavailable', 'provider_error') then
    raise exception 'unknown outcome' using errcode = '22023';
  end if;
  if p_executions is null or jsonb_typeof(p_executions) <> 'array' or jsonb_array_length(p_executions) > 2 then
    raise exception 'executions must be an array of at most 2 calls' using errcode = '22023';
  end if;
  if p_outcome = 'transcribed' and not exists (
    select 1 from jsonb_array_elements(p_executions) e where e ->> 'status' = 'ok'
  ) then
    raise exception 'a transcription needs the call that produced it' using errcode = '22023';
  end if;

  select * into v_request from public.ai_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'request not found' using errcode = 'PT404';
  end if;
  if v_request.profile <> 'dictation' then
    raise exception 'only a dictation is settled in seconds' using errcode = '22023';
  end if;
  if v_request.status <> 'reserved' then
    return 'already_finished';
  end if;

  for v_execution in select value from jsonb_array_elements(p_executions) loop
    v_attempt := v_attempt + 1;
    insert into public.ai_executions (
      tenant_id, request_id, attempt, provider, model, status, audio_seconds, latency_ms, http_status
    )
    values (
      v_request.tenant_id, v_request.id, v_attempt,
      v_execution ->> 'provider', v_execution ->> 'model', v_execution ->> 'status',
      coalesce((v_execution ->> 'audioSeconds')::bigint, 0),
      coalesce((v_execution ->> 'latencyMs')::integer, 0),
      (v_execution ->> 'httpStatus')::smallint
    );
    v_seconds := v_seconds + coalesce((v_execution ->> 'audioSeconds')::bigint, 0);
    v_latency := v_latency + coalesce((v_execution ->> 'latencyMs')::integer, 0);
  end loop;

  update public.usage_buckets b
  set reserved = greatest(0, b.reserved - v_request.reserved_seconds),
      consumed = b.consumed + v_seconds
  where b.tenant_id = v_request.tenant_id and b.id = v_request.bucket_id;
  update public.ai_platform_days d
  set audio_reserved = greatest(0, d.audio_reserved - v_request.reserved_seconds),
      audio_consumed = d.audio_consumed + v_seconds
  where d.day = v_request.platform_day;

  update public.ai_requests r
  set status = case when p_outcome = 'transcribed' then 'completed' else 'failed' end,
      outcome = p_outcome,
      audio_seconds = v_seconds,
      latency_ms = least(v_latency, 2147483647)::integer,
      finished_at = now()
  where r.id = v_request.id;
  return 'settled';
end;
$$;

revoke all on function ai_api.begin_dictation(uuid, integer, text) from public;
revoke all on function ai_api.finish_dictation(uuid, text, jsonb) from public;
grant execute on function ai_api.begin_dictation(uuid, integer, text) to rikuy_ai;
grant execute on function ai_api.finish_dictation(uuid, text, jsonb) to rikuy_ai;

-- ── Orphan reservations: tokens or seconds ──────────────────────────────────

create or replace function private.expire_ai_requests()
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
    if v_request.profile = 'dictation' then
      update public.usage_buckets b
      set reserved = greatest(0, b.reserved - v_request.reserved_seconds),
          consumed = b.consumed + v_request.reserved_seconds
      where b.tenant_id = v_request.tenant_id and b.id = v_request.bucket_id;
      update public.ai_platform_days d
      set audio_reserved = greatest(0, d.audio_reserved - v_request.reserved_seconds),
          audio_consumed = d.audio_consumed + v_request.reserved_seconds
      where d.day = v_request.platform_day;
    else
      update public.usage_buckets b
      set reserved = greatest(0, b.reserved - v_request.reserved_tokens),
          consumed = b.consumed + v_request.reserved_tokens
      where b.tenant_id = v_request.tenant_id and b.id = v_request.bucket_id;
      update public.ai_platform_days d
      set reserved = greatest(0, d.reserved - v_request.reserved_tokens),
          consumed = d.consumed + v_request.reserved_tokens
      where d.day = v_request.platform_day;
    end if;
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

-- ── Reading: AI counts the assistant only; voice has its own ────────────────

create or replace function public.tenant_ai_usage(p_tenant_id uuid)
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
          where r.tenant_id = p_tenant_id and r.profile <> 'dictation' and r.status = 'rejected'
            and r.created_at >= p.period_start)
  from private.usage_period(p_tenant_id, 'ai_tokens') p
  left join public.usage_buckets b
    on b.tenant_id = p_tenant_id and b.resource = 'ai_tokens' and b.period_start = p.period_start;
end;
$$;

create or replace function public.platform_ai_usage()
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
          where r.tenant_id = t.id and r.profile <> 'dictation' and r.status = 'rejected'
            and r.created_at >= p.period_start)
  from public.tenants t
  cross join lateral private.usage_period(t.id, 'ai_tokens') p
  left join public.usage_buckets b
    on b.tenant_id = t.id and b.resource = 'ai_tokens' and b.period_start = p.period_start
  order by t.display_name;
end;
$$;

-- The municipality's dictation today (any member), without creating buckets.
create function public.tenant_voice_usage(p_tenant_id uuid)
returns table (
  limit_amount      bigint,
  reserved          bigint,
  consumed          bigint,
  period_start      timestamptz,
  period_end        timestamptz,
  transcribed_today bigint,
  refused_today     bigint
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
  select coalesce(b.limit_amount, private.quota_limit(p_tenant_id, 'ai_audio_seconds')),
         coalesce(b.reserved, 0), coalesce(b.consumed, 0), p.period_start, p.period_end,
         (select count(*) from public.ai_requests r
          where r.tenant_id = p_tenant_id and r.outcome = 'transcribed' and r.created_at >= p.period_start),
         (select count(*) from public.ai_requests r
          where r.tenant_id = p_tenant_id and r.profile = 'dictation' and r.status = 'rejected'
            and r.created_at >= p.period_start)
  from private.usage_period(p_tenant_id, 'ai_audio_seconds') p
  left join public.usage_buckets b
    on b.tenant_id = p_tenant_id and b.resource = 'ai_audio_seconds' and b.period_start = p.period_start;
end;
$$;

-- Every municipality's dictation today, for the platform operator (second factor).
create function public.platform_voice_usage()
returns table (
  tenant_id         uuid,
  slug              text,
  display_name      text,
  status            public.tenant_status,
  limit_amount      bigint,
  is_default        boolean,
  reserved          bigint,
  consumed          bigint,
  period_start      timestamptz,
  period_end        timestamptz,
  transcribed_today bigint,
  refused_today     bigint
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
         coalesce(b.limit_amount, private.quota_limit(t.id, 'ai_audio_seconds')),
         not exists (select 1 from public.tenant_quotas q where q.tenant_id = t.id and q.resource = 'ai_audio_seconds'),
         coalesce(b.reserved, 0), coalesce(b.consumed, 0), p.period_start, p.period_end,
         (select count(*) from public.ai_requests r
          where r.tenant_id = t.id and r.outcome = 'transcribed' and r.created_at >= p.period_start),
         (select count(*) from public.ai_requests r
          where r.tenant_id = t.id and r.profile = 'dictation' and r.status = 'rejected'
            and r.created_at >= p.period_start)
  from public.tenants t
  cross join lateral private.usage_period(t.id, 'ai_audio_seconds') p
  left join public.usage_buckets b
    on b.tenant_id = t.id and b.resource = 'ai_audio_seconds' and b.period_start = p.period_start
  order by t.display_name;
end;
$$;

revoke all on function public.tenant_voice_usage(uuid) from public, anon, authenticated;
revoke all on function public.platform_voice_usage() from public, anon, authenticated;
grant execute on function public.tenant_voice_usage(uuid) to authenticated;
grant execute on function public.platform_voice_usage() to authenticated;

-- ── Operations snapshot (ADR-035): voice under its own key ──────────────────

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
      cross join unnest(array['storage_bytes', 'media_compute_seconds']::public.usage_resource[]) as r (resource)
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
    -- AI (ADR-036): the assistant's tokens.
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
        where r.profile <> 'dictation' and r.status = 'rejected' and r.created_at > now() - interval '24 hours'
      ),
      'failed24h', (
        select count(*) from public.ai_requests r
        where r.profile <> 'dictation' and r.status in ('failed', 'expired')
          and r.created_at > now() - interval '24 hours'
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
    -- Voice (ADR-041): the platform's audio seconds today (UTC), the last 24 hours and the
    -- municipalities at 80 % or more of their daily dictation.
    'voice', jsonb_build_object(
      'used', coalesce((
        select d.audio_consumed + d.audio_reserved from public.ai_platform_days d
        where d.day = private.ai_platform_day()
      ), 0),
      'limit', coalesce((
        select d.limit_audio_seconds from public.ai_platform_days d
        where d.day = private.ai_platform_day()
      ), private.ai_platform_audio_daily_limit()),
      'transcribed24h', (
        select count(*) from public.ai_requests r
        where r.outcome = 'transcribed' and r.created_at > now() - interval '24 hours'
      ),
      'refused24h', (
        select count(*) from public.ai_requests r
        where r.profile = 'dictation' and r.status = 'rejected' and r.created_at > now() - interval '24 hours'
      ),
      'failed24h', (
        select count(*) from public.ai_requests r
        where r.profile = 'dictation' and r.status in ('failed', 'expired')
          and r.created_at > now() - interval '24 hours'
      ),
      'quotas', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'tenant', t.display_name, 'slug', t.slug,
                 'used', coalesce(b.consumed, 0) + coalesce(b.reserved, 0),
                 'limit', coalesce(b.limit_amount, private.quota_limit(t.id, 'ai_audio_seconds')))
               order by t.display_name)
        from public.tenants t
        cross join lateral private.usage_period(t.id, 'ai_audio_seconds') p
        left join public.usage_buckets b
          on b.tenant_id = t.id and b.resource = 'ai_audio_seconds' and b.period_start = p.period_start
        where t.status <> 'suspended'
          and coalesce(b.limit_amount, private.quota_limit(t.id, 'ai_audio_seconds')) > 0
          and (coalesce(b.consumed, 0) + coalesce(b.reserved, 0)) * 5
              >= coalesce(b.limit_amount, private.quota_limit(t.id, 'ai_audio_seconds')) * 4
      ), '[]'::jsonb)
    ),
    'at', now()
  );
$$;
