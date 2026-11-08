-- P6 · Paso 2 — metrics per municipality for the operator (ADR-044). Expand only.
--
-- 1. request_errors: server errors with the proxy's request ID and Next.js digest, 30 days.
-- 2. route_latency_hourly: per municipality, hour and route, a 9-bucket histogram (no row
--    per request). Written by the web app through worker_api after responding.
-- 3. portal_probes: a daily job per municipality online times its home, /mapa and one
--    public media file from the function's region.
-- 4. ai_prices + ai_executions.estimated_cost_usd/price_version: an estimated cost at a
--    versioned public price (the current free plan costs 0).
-- 5. publication_checks: what is published is complete (public files, tour manifests,
--    logo, the assistant's index); daily for municipalities online and on demand.
-- 6. Readings for operators with a second factor; every figure with its source and period.
--
-- Telemetry is written only by rikuy_worker (worker_api): neither the public key nor a
-- user session can write metrics. Nobody reads the tables directly.

-- ── 1. Errors ─────────────────────────────────────────────────────────────

create table public.request_errors (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants (id) on delete cascade,
  request_id  uuid not null,
  digest      text,
  surface     text not null,
  route       text not null,
  method      text not null,
  kind        text not null,
  message     text not null default '',
  occurred_at timestamptz not null default now(),

  constraint request_errors_surface check (surface in ('portal', 'admin', 'platform')),
  constraint request_errors_route check (route ~ '^/[A-Za-z0-9_./\[\]-]{0,199}$'),
  constraint request_errors_method check (method ~ '^[A-Z]{3,7}$'),
  constraint request_errors_kind check (kind ~ '^[A-Za-z][A-Za-z0-9_.]{0,59}$'),
  constraint request_errors_digest check (digest is null or digest ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint request_errors_message check (char_length(message) <= 300)
);

create index request_errors_tenant_time_idx on public.request_errors (tenant_id, occurred_at desc);
create index request_errors_request_idx on public.request_errors (request_id);
create index request_errors_digest_idx on public.request_errors (digest) where digest is not null;

alter table public.request_errors enable row level security;
revoke all on public.request_errors from public, anon, authenticated, service_role;

-- The tenant comes from the proxy's tenant context (portal) or the panel's /o/{slug}. An
-- unknown tenant or slug is recorded without a tenant. At most 1,000 errors per tenant and
-- hour are kept (a broken page must not fill the database).
create function worker_api.record_request_error(
  p_request_id uuid,
  p_digest     text,
  p_surface    text,
  p_tenant_id  uuid,
  p_slug       text,
  p_route      text,
  p_method     text,
  p_kind       text,
  p_message    text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  if p_tenant_id is not null then
    select t.id into v_tenant from public.tenants t where t.id = p_tenant_id;
  elsif p_slug is not null then
    select t.id into v_tenant from public.tenants t where t.slug = p_slug;
  end if;

  if (
    select count(*) from public.request_errors e
    where e.tenant_id is not distinct from v_tenant and e.occurred_at > now() - interval '1 hour'
  ) >= 1000 then
    return false;
  end if;

  insert into public.request_errors (
    tenant_id, request_id, digest, surface, route, method, kind, message
  )
  values (
    v_tenant,
    coalesce(p_request_id, gen_random_uuid()),
    case when p_digest ~ '^[A-Za-z0-9_-]{1,64}$' then p_digest end,
    p_surface,
    case when p_route ~ '^/[A-Za-z0-9_./\[\]-]{0,199}$' then p_route else '/' end,
    case when upper(coalesce(p_method, '')) ~ '^[A-Z]{3,7}$' then upper(p_method) else 'GET' end,
    case when p_kind ~ '^[A-Za-z][A-Za-z0-9_.]{0,59}$' then p_kind else 'Error' end,
    coalesce(left(private.clean_error_message(nullif(p_message, '')), 300), '')
  );
  return true;
end;
$$;

revoke all on function worker_api.record_request_error(uuid, text, text, uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function worker_api.record_request_error(uuid, text, text, uuid, text, text, text, text, text)
  to rikuy_worker;

-- ── 2. Route latency, per hour ────────────────────────────────────────────

create function private.latency_bounds()
returns integer[]
language sql
immutable
set search_path = ''
as $$
  select array[50, 100, 200, 400, 800, 1600, 3200, 6400]::integer[];
$$;

revoke all on function private.latency_bounds() from public;

create table public.route_latency_hourly (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  hour      timestamptz not null,
  route     text not null,
  requests  integer not null default 0,
  errors    integer not null default 0,
  total_ms  bigint not null default 0,
  -- ≤ 50, ≤ 100, ≤ 200, ≤ 400, ≤ 800, ≤ 1600, ≤ 3200, ≤ 6400 ms and more.
  buckets   integer[] not null default array_fill(0, array[9]),

  primary key (tenant_id, hour, route),
  constraint route_latency_hourly_route check (
    route in ('assistant', 'dictation', 'assistant_places', 'map_places', 'tour_data')
  ),
  constraint route_latency_hourly_hour check (hour = date_trunc('hour', hour)),
  constraint route_latency_hourly_buckets check (
    array_length(buckets, 1) = 9 and array_position(buckets, null) is null
  ),
  constraint route_latency_hourly_counts check (
    requests >= 0 and errors >= 0 and errors <= requests and total_ms >= 0
  )
);

alter table public.route_latency_hourly enable row level security;
revoke all on public.route_latency_hourly from public, anon, authenticated, service_role;

create function worker_api.record_route_latency(
  p_tenant_id uuid,
  p_route     text,
  p_ms        integer,
  p_status    integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ms integer := least(greatest(coalesce(p_ms, 0), 0), 600000);
  v_bucket integer;
  v_error integer := case when coalesce(p_status, 200) >= 500 then 1 else 0 end;
  v_hour timestamptz := date_trunc('hour', now());
begin
  if p_route not in ('assistant', 'dictation', 'assistant_places', 'map_places', 'tour_data')
     or not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    return false;
  end if;
  v_bucket := 1 + (select count(*)::integer from unnest(private.latency_bounds()) b where v_ms > b);

  insert into public.route_latency_hourly as h (tenant_id, hour, route, requests, errors, total_ms, buckets)
  values (
    p_tenant_id, v_hour, p_route, 1, v_error, v_ms,
    (select array_agg(case when i = v_bucket then 1 else 0 end order by i) from generate_series(1, 9) i)
  )
  on conflict (tenant_id, hour, route) do update
  set requests = h.requests + 1,
      errors = h.errors + v_error,
      total_ms = h.total_ms + v_ms,
      buckets[v_bucket] = h.buckets[v_bucket] + 1;
  return true;
end;
$$;

revoke all on function worker_api.record_route_latency(uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function worker_api.record_route_latency(uuid, text, integer, integer) to rikuy_worker;

-- The upper bound (ms) of the bucket that holds the given share of the requests; 6401 means
-- «more than 6.4 s»; null without requests.
create function private.histogram_percentile(p_buckets integer[], p_share numeric)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_total bigint := 0;
  v_seen bigint := 0;
  v_bounds integer[] := private.latency_bounds();
begin
  select coalesce(sum(b), 0) into v_total from unnest(p_buckets) b;
  if v_total = 0 then
    return null;
  end if;
  for i in 1 .. 9 loop
    v_seen := v_seen + coalesce(p_buckets[i], 0);
    if v_seen >= ceil(v_total * p_share) then
      return case when i <= 8 then v_bounds[i] else 6401 end;
    end if;
  end loop;
  return 6401;
end;
$$;

revoke all on function private.histogram_percentile(integer[], numeric) from public;

-- Element-wise sum of histograms (aggregate).
create function private.histogram_add(p_left integer[], p_right integer[])
returns integer[]
language sql
immutable
set search_path = ''
as $$
  select array_agg(coalesce(p_left[i], 0) + coalesce(p_right[i], 0) order by i)
  from generate_series(1, 9) i;
$$;

create aggregate private.histogram_sum(integer[]) (
  sfunc = private.histogram_add,
  stype = integer[],
  initcond = '{0,0,0,0,0,0,0,0,0}'
);

revoke all on function private.histogram_add(integer[], integer[]) from public;

-- ── 3. Daily probe of each portal ─────────────────────────────────────────

create table public.portal_probes (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  job_id    uuid,
  probed_at timestamptz not null default now(),
  target    text not null,
  path      text not null,
  status    smallint,
  ttfb_ms   integer,
  total_ms  integer,
  bytes     integer,
  cache     text,
  error     text,

  constraint portal_probes_target check (target in ('home', 'map', 'media')),
  constraint portal_probes_path check (char_length(path) between 1 and 300),
  constraint portal_probes_status check (status is null or status between 100 and 599),
  constraint portal_probes_times check (
    (ttfb_ms is null or ttfb_ms between 0 and 600000)
    and (total_ms is null or total_ms between 0 and 600000)
    and (bytes is null or bytes >= 0)
  ),
  constraint portal_probes_cache check (cache is null or cache ~ '^[A-Z_]{1,20}$'),
  constraint portal_probes_error check (error is null or char_length(error) <= 120),
  constraint portal_probes_outcome check ((status is null) = (error is not null))
);

create index portal_probes_tenant_time_idx on public.portal_probes (tenant_id, probed_at desc);

alter table public.portal_probes enable row level security;
revoke all on public.portal_probes from public, anon, authenticated, service_role;

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values ('metrics.probe_portal', 'system', 2, 60, 90, 1, 'Sonda diaria del portal');

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
                    'media.remove_unused', 'media.extract_document') then
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
    -- {"source": "content" | "tour", "revisionId": uuid}; the job's subject is that revision.
    when p_kind = 'knowledge.index' then
      jsonb_typeof(p_payload) = 'object'
      and private.has_exact_keys(p_payload, array['source', 'revisionId'])
      and p_payload ->> 'source' in ('content', 'tour')
      and coalesce(p_payload ->> 'revisionId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    -- {}: the job's tenant is what gets probed (ADR-044).
    when p_kind = 'metrics.probe_portal' then
      p_payload = '{}'::jsonb
    else false
  end;
$$;

-- One probe per municipality online and UTC day.
create function private.enqueue_portal_probes()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant record;
  v_created integer := 0;
  v_new boolean;
begin
  for v_tenant in select t.id from public.tenants t where t.status = 'active' order by t.id loop
    select e.created into v_new
    from private.enqueue_job(
      v_tenant.id, 'metrics.probe_portal',
      'probe:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD'),
      '{}'::jsonb, 'tenant', v_tenant.id
    ) e;
    if v_new then
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end;
$$;

revoke all on function private.enqueue_portal_probes() from public;

-- What to probe, under the job's lease: the canonical host of the job's tenant and its most
-- recent public image (null when it has none).
create function worker_api.portal_probe_target(p_job_id uuid, p_fencing_token bigint)
returns table (host text, media_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'metrics.probe_portal' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  return query
  select
    d.hostname,
    (
      select o.name from storage.objects o
      where o.bucket_id = 'media-public'
        and o.name like v_job.tenant_id::text || '/%'
        and o.name ~ '\.(webp|png|jpe?g)$'
      order by o.created_at desc
      limit 1
    )
  from public.tenants t
  join public.tenant_domains d on d.id = t.canonical_domain_id
  where t.id = v_job.tenant_id and t.status = 'active' and d.status = 'active';
end;
$$;

revoke all on function worker_api.portal_probe_target(uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function worker_api.portal_probe_target(uuid, bigint) to rikuy_worker;

-- [{"target", "path", "status"|null, "ttfbMs", "totalMs", "bytes", "cache", "error"|null}, …]
create function worker_api.record_portal_probe(p_job_id uuid, p_fencing_token bigint, p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_result jsonb;
  v_count integer := 0;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'metrics.probe_portal' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  if jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) > 3 then
    raise exception 'results must be an array of at most 3 probes' using errcode = '22023';
  end if;
  for v_result in select value from jsonb_array_elements(p_results) loop
    insert into public.portal_probes (
      tenant_id, job_id, target, path, status, ttfb_ms, total_ms, bytes, cache, error
    )
    values (
      v_job.tenant_id, v_job.id,
      v_result ->> 'target',
      v_result ->> 'path',
      (v_result ->> 'status')::smallint,
      (v_result ->> 'ttfbMs')::integer,
      (v_result ->> 'totalMs')::integer,
      (v_result ->> 'bytes')::integer,
      v_result ->> 'cache',
      v_result ->> 'error'
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function worker_api.record_portal_probe(uuid, bigint, jsonb) from public, anon, authenticated, service_role;
grant execute on function worker_api.record_portal_probe(uuid, bigint, jsonb) to rikuy_worker;

-- ── 4. Estimated AI cost at a versioned price ─────────────────────────────

create table public.ai_prices (
  version             text not null,
  provider            text not null,
  model               text not null,
  input_usd_per_mtok  numeric(12, 6) not null default 0,
  output_usd_per_mtok numeric(12, 6) not null default 0,
  audio_usd_per_hour  numeric(12, 6) not null default 0,
  effective_from      timestamptz not null,
  source              text not null,

  primary key (provider, model, effective_from),
  constraint ai_prices_version check (version ~ '^[a-z0-9][a-z0-9.-]{1,39}$'),
  constraint ai_prices_nonnegative check (
    input_usd_per_mtok >= 0 and output_usd_per_mtok >= 0 and audio_usd_per_hour >= 0
  )
);

alter table public.ai_prices enable row level security;
revoke all on public.ai_prices from public, anon, authenticated, service_role;

-- Groq's public on-demand price (October 2026); the current free plan costs 0.
insert into public.ai_prices (version, provider, model, input_usd_per_mtok, output_usd_per_mtok, audio_usd_per_hour, effective_from, source)
values
  ('groq-2026-10', 'groq', 'openai/gpt-oss-120b', 0.15, 0.60, 0, '2026-10-01T00:00:00Z',
   'Tarifa pública de Groq, GPT-OSS 120B (referencia del 2026-10-13)'),
  ('groq-2026-10', 'groq', 'whisper-large-v3-turbo', 0, 0, 0.04, '2026-10-01T00:00:00Z',
   'Tarifa pública de Groq, Whisper Large v3 Turbo (referencia del 2026-10-13)');

alter table public.ai_executions
  add column price_version text,
  add column estimated_cost_usd numeric(14, 8);

alter table public.ai_executions add constraint ai_executions_cost check (
  (price_version is null) = (estimated_cost_usd is null)
  and (estimated_cost_usd is null or estimated_cost_usd >= 0)
);

create function private.ai_execution_cost(
  p_provider text, p_model text, p_at timestamptz,
  p_input bigint, p_output bigint, p_audio_seconds bigint
)
returns table (price_version text, estimated_cost_usd numeric)
language sql
stable
set search_path = ''
as $$
  select
    p.version,
    round(
      coalesce(p_input, 0) * p.input_usd_per_mtok / 1000000
      + coalesce(p_output, 0) * p.output_usd_per_mtok / 1000000
      + coalesce(p_audio_seconds, 0) * p.audio_usd_per_hour / 3600,
      8
    )
  from public.ai_prices p
  where p.provider = p_provider and p.model = p_model and p.effective_from <= p_at
  order by p.effective_from desc
  limit 1;
$$;

revoke all on function private.ai_execution_cost(text, text, timestamptz, bigint, bigint, bigint) from public;

create function private.price_ai_execution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select c.price_version, c.estimated_cost_usd into new.price_version, new.estimated_cost_usd
  from private.ai_execution_cost(
    new.provider, new.model, coalesce(new.created_at, now()),
    new.input_tokens, new.output_tokens, new.audio_seconds
  ) c;
  return new;
end;
$$;

revoke all on function private.price_ai_execution() from public;

create trigger ai_executions_price
  before insert on public.ai_executions
  for each row execute function private.price_ai_execution();

-- The calls already recorded, at the same price.
update public.ai_executions e
set (price_version, estimated_cost_usd) = (
  select c.price_version, c.estimated_cost_usd
  from private.ai_execution_cost(
    e.provider, e.model, e.created_at, e.input_tokens, e.output_tokens, e.audio_seconds
  ) c
)
where e.price_version is null
  and exists (
    select 1 from public.ai_prices p
    where p.provider = e.provider and p.model = e.model and p.effective_from <= e.created_at
  );

-- ── 5. Integrity of what is published ─────────────────────────────────────

create table public.publication_checks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  checked_at    timestamptz not null default now(),
  trigger       text not null,
  actor_id      uuid,
  checked       jsonb not null,
  problems      jsonb not null default '[]'::jsonb,
  problem_count integer not null,
  duration_ms   integer not null,

  constraint publication_checks_trigger check (trigger in ('daily', 'manual')),
  constraint publication_checks_actor check ((trigger = 'manual') = (actor_id is not null)),
  constraint publication_checks_checked check (jsonb_typeof(checked) = 'object'),
  constraint publication_checks_problems check (
    jsonb_typeof(problems) = 'array' and jsonb_array_length(problems) <= 200
  ),
  constraint publication_checks_counts check (
    problem_count >= jsonb_array_length(problems) and duration_ms >= 0
  )
);

create index publication_checks_tenant_time_idx on public.publication_checks (tenant_id, checked_at desc);

alter table public.publication_checks enable row level security;
revoke all on public.publication_checks from public, anon, authenticated, service_role;

-- True when the public bucket has at least one file of that asset version.
create function private.has_public_files(p_tenant uuid, p_asset uuid, p_version integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from storage.objects o
    where o.bucket_id = 'media-public'
      and o.name like p_tenant::text || '/' || p_asset::text || '/' || p_version::text || '/%'
  );
$$;

revoke all on function private.has_public_files(uuid, uuid, integer) from public;

-- Checks one municipality and stores the result. Problems:
--   photo_missing      a photo of published content has no public copy
--   tour_file_missing  a file named by a published tour's manifest does not exist
--   tour_photo_missing a photo of a published tour's point has no public copy
--   logo_missing       the active brand's logo has no public copy
--   not_indexed        a published revision the assistant has not read (published > 15 min ago)
create function private.check_publication(p_tenant uuid, p_trigger text, p_actor uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_problems jsonb;
  v_count integer;
  v_checked jsonb;
  v_id uuid;
begin
  with
  -- Photos of published content.
  content_photos as (
    select 'photo_missing'::text as kind, r.title, mr.alt_text as detail
    from public.content_items i
    join public.content_revisions r on r.tenant_id = i.tenant_id and r.id = i.published_revision_id
    join public.media_references mr on mr.tenant_id = r.tenant_id and mr.revision_id = r.id
    join public.asset_versions v on v.tenant_id = mr.tenant_id and v.id = mr.asset_version_id
    where i.tenant_id = p_tenant
      and not private.has_public_files(v.tenant_id, v.asset_id, v.version)
  ),
  tours as (
    select r.manifest, coalesce(c.title, 'Tour') as title
    from public.tours t
    join public.tour_revisions r on r.tenant_id = t.tenant_id and r.id = t.published_revision_id
    left join public.content_items ci on ci.tenant_id = t.tenant_id and ci.id = t.content_id
    left join public.content_revisions c on c.tenant_id = ci.tenant_id and c.id = ci.published_revision_id
    where t.tenant_id = p_tenant and r.manifest is not null
  ),
  scenes as (
    select tours.title, s.value as scene
    from tours, jsonb_array_elements(tours.manifest -> 'scenes') s
  ),
  -- Every file a published tour's manifest names.
  tour_files as (
    select title, scene ->> 'title' as scene_title,
           (scene -> 'panorama' ->> 'folder') || (scene -> 'panorama' -> 'preview' ->> 'file') as name
    from scenes
    union all
    select title, scene ->> 'title',
           (scene -> 'panorama' ->> 'folder') || (scene -> 'panorama' -> 'image' ->> 'file')
    from scenes
    union all
    select title, scene ->> 'title',
           (scene -> 'panorama' ->> 'folder') || (l.value ->> 'dir') || '/' || c || '_' || rw || '.webp'
    from scenes,
         jsonb_array_elements(coalesce(scene -> 'panorama' -> 'tiles' -> 'levels', '[]'::jsonb)) l,
         generate_series(0, (l.value ->> 'cols')::integer - 1) c,
         generate_series(0, (l.value ->> 'rows')::integer - 1) rw
    union all
    select title, scene ->> 'title', (h.value -> 'model' ->> 'folder') || (h.value -> 'model' ->> 'file')
    from scenes, jsonb_array_elements(scene -> 'hotspots') h
    where jsonb_typeof(h.value -> 'model') = 'object'
    union all
    select title, scene ->> 'title',
           (h.value -> 'model' ->> 'folder') || (h.value -> 'model' -> 'poster' ->> 'file')
    from scenes, jsonb_array_elements(scene -> 'hotspots') h
    where jsonb_typeof(h.value -> 'model') = 'object'
  ),
  missing_tour_files as (
    select 'tour_file_missing'::text as kind, f.title, f.scene_title || ': ' || f.name as detail
    from tour_files f
    where not exists (
      select 1 from storage.objects o where o.bucket_id = 'media-public' and o.name = f.name
    )
  ),
  -- Photos of the points of published tours.
  tour_photos as (
    select 'tour_photo_missing'::text as kind, s.value ->> 'title' as title, g.value ->> 'alt' as detail
    from public.tours t
    join public.tour_revisions r on r.tenant_id = t.tenant_id and r.id = t.published_revision_id,
         jsonb_array_elements(r.manifest -> 'scenes') s,
         jsonb_array_elements(s.value -> 'hotspots') h,
         jsonb_array_elements(coalesce(h.value -> 'gallery', '[]'::jsonb)) g
    where t.tenant_id = p_tenant and r.manifest is not null
      and not private.has_public_files(
        p_tenant, (g.value ->> 'assetId')::uuid, (g.value ->> 'version')::integer
      )
  ),
  -- The active brand's logo.
  logo as (
    select 'logo_missing'::text as kind, 'Marca del portal'::text as title, 'logo'::text as detail
    from public.tenants t
    join public.tenant_config_versions c on c.tenant_id = t.id and c.id = t.active_config_id
    where t.id = p_tenant
      and jsonb_typeof(c.branding -> 'logo') = 'object'
      and not private.has_public_files(
        p_tenant, (c.branding -> 'logo' ->> 'assetId')::uuid, (c.branding -> 'logo' ->> 'version')::integer
      )
  ),
  -- What the assistant has read (published more than 15 minutes ago).
  unread as (
    select 'not_indexed'::text as kind, r.title, i.kind::text as detail
    from public.content_items i
    join public.content_revisions r on r.tenant_id = i.tenant_id and r.id = i.published_revision_id
    where i.tenant_id = p_tenant
      and r.sealed_at < now() - interval '15 minutes'
      and not exists (
        select 1 from public.knowledge_indexed_revisions k
        where k.tenant_id = r.tenant_id and k.content_revision_id = r.id
      )
    union all
    select 'not_indexed', coalesce(c.title, 'Tour'), 'tour'
    from public.tours t
    join public.tour_revisions r on r.tenant_id = t.tenant_id and r.id = t.published_revision_id
    left join public.content_items ci on ci.tenant_id = t.tenant_id and ci.id = t.content_id
    left join public.content_revisions c on c.tenant_id = ci.tenant_id and c.id = ci.published_revision_id
    where t.tenant_id = p_tenant
      and r.sealed_at < now() - interval '15 minutes'
      and not exists (
        select 1 from public.knowledge_indexed_revisions k
        where k.tenant_id = r.tenant_id and k.tour_revision_id = r.id
      )
  ),
  problems as (
    select * from content_photos
    union all select * from missing_tour_files
    union all select * from tour_photos
    union all select * from logo
    union all select * from unread
  )
  select
    (select count(*)::integer from problems),
    coalesce((
      select jsonb_agg(jsonb_build_object('kind', p.kind, 'title', p.title, 'detail', left(p.detail, 200)))
      from (select * from problems order by kind, title, detail limit 200) p
    ), '[]'::jsonb)
  into v_count, v_problems;

  v_checked := jsonb_build_object(
    'contents', (select count(*) from public.content_items i
                 where i.tenant_id = p_tenant and i.published_revision_id is not null),
    'photos', (select count(*) from public.content_items i
               join public.media_references mr on mr.tenant_id = i.tenant_id and mr.revision_id = i.published_revision_id
               where i.tenant_id = p_tenant),
    'tours', (select count(*) from public.tours t
              where t.tenant_id = p_tenant and t.published_revision_id is not null),
    'logo', (select count(*) from public.tenants t
             join public.tenant_config_versions c on c.tenant_id = t.id and c.id = t.active_config_id
             where t.id = p_tenant and jsonb_typeof(c.branding -> 'logo') = 'object')
  );

  insert into public.publication_checks (
    tenant_id, checked_at, trigger, actor_id, checked, problems, problem_count, duration_ms
  )
  values (
    p_tenant, clock_timestamp(), p_trigger, p_actor, v_checked, v_problems, v_count,
    greatest(0, (extract(epoch from clock_timestamp() - v_started) * 1000)::integer)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function private.check_publication(uuid, text, uuid) from public;

create function private.check_publication_daily()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant record;
  v_count integer := 0;
begin
  for v_tenant in select t.id from public.tenants t where t.status = 'active' order by t.id loop
    perform private.check_publication(v_tenant.id, 'daily', null);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.check_publication_daily() from public;

-- ── Retention ─────────────────────────────────────────────────────────────

create function private.delete_old_metrics()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.request_errors where occurred_at < now() - interval '30 days';
  delete from public.route_latency_hourly where hour < now() - interval '30 days';
  delete from public.portal_probes where probed_at < now() - interval '90 days';
  delete from public.publication_checks where checked_at < now() - interval '30 days';
$$;

revoke all on function private.delete_old_metrics() from public;

select cron.schedule('rikuy-probe-portals', '27 7 * * *', $$select private.enqueue_portal_probes()$$);
select cron.schedule('rikuy-check-publication', '57 7 * * *', $$select private.check_publication_daily()$$);
select cron.schedule('rikuy-delete-old-metrics', '7 8 * * *', $$select private.delete_old_metrics()$$);

-- ── 6. Readings for operators with a second factor ────────────────────────

create function private.assert_operator()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_operator(true) then
    raise exception 'platform operator with a second factor required' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.assert_operator() from public;

-- Every municipality at a glance. Periods: the last 24 hours and 7 days by the database's
-- clock (generatedAt); probes and checks, their latest run.
create function public.platform_metrics_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
begin
  perform private.assert_operator();
  return jsonb_build_object(
    'generatedAt', v_now,
    'platformErrors', jsonb_build_object(
      'last24h', (select count(*) from public.request_errors e
                  where e.tenant_id is null and e.occurred_at > v_now - interval '24 hours'),
      'last7d', (select count(*) from public.request_errors e
                 where e.tenant_id is null and e.occurred_at > v_now - interval '7 days')
    ),
    'tenants', coalesce((
      select jsonb_agg(entry order by entry ->> 'displayName')
      from (
        select jsonb_build_object(
          'tenantId', t.id,
          'slug', t.slug,
          'displayName', t.display_name,
          'status', t.status,
          'errors24h', (select count(*) from public.request_errors e
                        where e.tenant_id = t.id and e.occurred_at > v_now - interval '24 hours'),
          'requests24h', (select coalesce(sum(h.requests), 0) from public.route_latency_hourly h
                          where h.tenant_id = t.id and h.hour > v_now - interval '24 hours'),
          'p95Ms24h', (select private.histogram_percentile(private.histogram_sum(h.buckets), 0.95)
                       from public.route_latency_hourly h
                       where h.tenant_id = t.id and h.hour > v_now - interval '24 hours'),
          'jobsFailed7d', (select count(*) from public.background_jobs j
                           where j.tenant_id = t.id and j.status = 'dead_letter'
                             and j.updated_at > v_now - interval '7 days'),
          'jobsWaiting', (select count(*) from public.background_jobs j
                          where j.tenant_id = t.id and j.status = 'pending' and j.available_at <= v_now),
          'aiCalls7d', (select count(*) from public.ai_executions x
                        where x.tenant_id = t.id and x.created_at > v_now - interval '7 days'),
          'aiCostUsd7d', (select coalesce(sum(x.estimated_cost_usd), 0) from public.ai_executions x
                          where x.tenant_id = t.id and x.created_at > v_now - interval '7 days'),
          'probe', (select jsonb_build_object('probedAt', p.probed_at, 'status', p.status, 'ttfbMs', p.ttfb_ms)
                    from public.portal_probes p
                    where p.tenant_id = t.id and p.target = 'home'
                    order by p.probed_at desc limit 1),
          'check', (select jsonb_build_object('checkedAt', c.checked_at, 'problems', c.problem_count)
                    from public.publication_checks c
                    where c.tenant_id = t.id
                    order by c.checked_at desc limit 1)
        ) as entry
        from public.tenants t
      ) entries
    ), '[]'::jsonb)
  );
end;
$$;

-- One municipality in detail.
create function public.platform_tenant_metrics(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
begin
  perform private.assert_operator();
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'unknown tenant' using errcode = 'PT404', hint = 'tenant';
  end if;

  return jsonb_build_object(
    'generatedAt', v_now,
    'errors', (
      select jsonb_build_object(
        'last24h', count(*) filter (where e.occurred_at > v_now - interval '24 hours'),
        'last7d', count(*),
        'byRoute', coalesce((
          select jsonb_agg(jsonb_build_object('route', r.route, 'surface', r.surface, 'count', r.n) order by r.n desc)
          from (
            select e2.route, e2.surface, count(*) as n
            from public.request_errors e2
            where e2.tenant_id = p_tenant_id and e2.occurred_at > v_now - interval '7 days'
            group by 1, 2 order by 3 desc limit 10
          ) r
        ), '[]'::jsonb)
      )
      from public.request_errors e
      where e.tenant_id = p_tenant_id and e.occurred_at > v_now - interval '7 days'
    ),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'route', x.route, 'period', x.period, 'requests', x.requests, 'errors', x.errors,
        'avgMs', case when x.requests > 0 then round(x.total_ms::numeric / x.requests) end,
        'p50Ms', private.histogram_percentile(x.buckets, 0.5),
        'p95Ms', private.histogram_percentile(x.buckets, 0.95)
      ) order by x.route, x.period)
      from (
        select h.route, p.period,
               sum(h.requests)::integer as requests, sum(h.errors)::integer as errors,
               sum(h.total_ms) as total_ms, private.histogram_sum(h.buckets) as buckets
        from public.route_latency_hourly h
        cross join (values ('24h', interval '24 hours'), ('7d', interval '7 days')) p (period, span)
        where h.tenant_id = p_tenant_id and h.hour > v_now - p.span
        group by h.route, p.period
      ) x
    ), '[]'::jsonb),
    'probes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'target', p.target, 'path', p.path, 'probedAt', p.probed_at, 'status', p.status,
        'ttfbMs', p.ttfb_ms, 'totalMs', p.total_ms, 'bytes', p.bytes, 'cache', p.cache, 'error', p.error
      ) order by p.target)
      from (
        select distinct on (pp.target) pp.*
        from public.portal_probes pp
        where pp.tenant_id = p_tenant_id
        order by pp.target, pp.probed_at desc
      ) p
    ), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', k.kind, 'created', k.created, 'succeeded', k.succeeded, 'deadLetter', k.dead_letter,
        'pending', k.pending, 'running', k.running, 'p95AttemptMs', k.p95_ms
      ) order by k.kind)
      from (
        select j.kind,
               count(*) as created,
               count(*) filter (where j.status = 'succeeded') as succeeded,
               count(*) filter (where j.status = 'dead_letter') as dead_letter,
               count(*) filter (where j.status = 'pending') as pending,
               count(*) filter (where j.status = 'running') as running,
               (select round(percentile_cont(0.95) within group (
                         order by extract(epoch from a.finished_at - a.started_at) * 1000))
                from public.job_attempts a
                join public.background_jobs j2 on j2.tenant_id = a.tenant_id and j2.id = a.job_id
                where a.tenant_id = p_tenant_id and j2.kind = j.kind and a.finished_at is not null
                  and a.started_at > v_now - interval '7 days') as p95_ms
        from public.background_jobs j
        where j.tenant_id = p_tenant_id and j.created_at > v_now - interval '7 days'
        group by j.kind
      ) k
    ), '[]'::jsonb),
    'jobsWaiting', jsonb_build_object(
      'ready', (select count(*) from public.background_jobs j
                where j.tenant_id = p_tenant_id and j.status = 'pending' and j.available_at <= v_now),
      'oldestWaitSeconds', (select extract(epoch from v_now - min(j.available_at))::integer
                            from public.background_jobs j
                            where j.tenant_id = p_tenant_id and j.status = 'pending' and j.available_at <= v_now),
      'deadLetterOpen', (select count(*) from public.background_jobs j
                         where j.tenant_id = p_tenant_id and j.status = 'dead_letter')
    ),
    'ai', coalesce((
      select jsonb_agg(jsonb_build_object(
        'period', a.period, 'model', a.model, 'calls', a.calls, 'failed', a.failed,
        'inputTokens', a.input_tokens, 'outputTokens', a.output_tokens, 'audioSeconds', a.audio_seconds,
        'costUsd', a.cost, 'unpriced', a.unpriced, 'priceVersions', a.versions,
        'p95LatencyMs', a.p95_ms
      ) order by a.period, a.model)
      from (
        select p.period, x.model,
               count(*) as calls,
               count(*) filter (where x.status <> 'ok') as failed,
               sum(x.input_tokens) as input_tokens, sum(x.output_tokens) as output_tokens,
               sum(x.audio_seconds) as audio_seconds,
               coalesce(sum(x.estimated_cost_usd), 0) as cost,
               count(*) filter (where x.price_version is null) as unpriced,
               coalesce(jsonb_agg(distinct x.price_version) filter (where x.price_version is not null), '[]'::jsonb) as versions,
               round(percentile_cont(0.95) within group (order by x.latency_ms)) as p95_ms
        from public.ai_executions x
        cross join (values ('24h', interval '24 hours'), ('7d', interval '7 days')) p (period, span)
        where x.tenant_id = p_tenant_id and x.created_at > v_now - p.span
        group by p.period, x.model
      ) a
    ), '[]'::jsonb),
    'aiRejected7d', (select count(*) from public.ai_requests r
                     where r.tenant_id = p_tenant_id and r.status = 'rejected'
                       and r.created_at > v_now - interval '7 days'),
    'check', (
      select jsonb_build_object(
        'checkedAt', c.checked_at, 'trigger', c.trigger, 'checked', c.checked,
        'problems', c.problems, 'problemCount', c.problem_count, 'durationMs', c.duration_ms
      )
      from public.publication_checks c
      where c.tenant_id = p_tenant_id
      order by c.checked_at desc limit 1
    )
  );
end;
$$;

-- The latest errors of one municipality (null: errors without a municipality), optionally
-- filtered by a request ID or a reference code (digest).
create function public.platform_tenant_errors(p_tenant_id uuid, p_search text default null, p_limit integer default 50)
returns table (
  id          uuid,
  occurred_at timestamptz,
  surface     text,
  route       text,
  method      text,
  kind        text,
  message     text,
  request_id  uuid,
  digest      text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform private.assert_operator();
  return query
  select e.id, e.occurred_at, e.surface, e.route, e.method, e.kind, e.message, e.request_id, e.digest
  from public.request_errors e
  where e.tenant_id is not distinct from p_tenant_id
    and (v_search is null or e.request_id::text = lower(v_search) or e.digest = v_search)
  order by e.occurred_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- «Revisar ahora»: runs the check for one municipality and returns its id.
create function public.platform_check_publication(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_operator();
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'unknown tenant' using errcode = 'PT404', hint = 'tenant';
  end if;
  return private.check_publication(p_tenant_id, 'manual', (select auth.uid()));
end;
$$;

revoke all on function public.platform_metrics_overview() from public, anon, authenticated;
revoke all on function public.platform_tenant_metrics(uuid) from public, anon, authenticated;
revoke all on function public.platform_tenant_errors(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.platform_check_publication(uuid) from public, anon, authenticated;
grant execute on function public.platform_metrics_overview() to authenticated;
grant execute on function public.platform_tenant_metrics(uuid) to authenticated;
grant execute on function public.platform_tenant_errors(uuid, text, integer) to authenticated;
grant execute on function public.platform_check_publication(uuid) to authenticated;
