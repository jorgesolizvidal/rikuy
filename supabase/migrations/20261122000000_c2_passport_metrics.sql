-- C2 · Paso 4 (ADR-059): the tourist passport in «Estadísticas», the monthly report and the
-- Copilot's recommendations. Expand only.
--
-- Until now the server kept nothing when a phone collected a stamp (ADR-057). From here on it
-- keeps daily totals per place: how many phones stamped it that day and, of those, how many
-- with the phone saying it was there («visitas comprobadas en el lugar»). A phone counts once
-- per place and day, through the same daily fingerprint as the visits (ADR-051), forgotten
-- two days later; nothing that identifies the phone is kept. Completed circuits and redeemed
-- prizes come from the vouchers (ADR-058), already kept.

-- ── Daily stamps ───────────────────────────────────────────────────────────

create table public.passport_daily_stamps (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  day        date not null,
  content_id uuid not null,
  stamps     integer not null default 0,
  located    integer not null default 0,
  primary key (tenant_id, day, content_id),
  constraint passport_daily_stamps_content_fk foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete cascade,
  constraint passport_daily_stamps_counts check (stamps >= 0 and located between 0 and stamps)
);

alter table public.passport_daily_stamps enable row level security;
-- No policies: read through tenant_passport_statistics, written only inside the stamp.
revoke all on table public.passport_daily_stamps from public, anon, authenticated, service_role;

-- Stamps a municipality can add up in one day; past it, stamps are still signed but not
-- counted (a script with a photo of a QR cannot inflate the totals without end).
create function private.passport_stamp_daily_cap()
returns integer
language sql
immutable
set search_path = ''
as $$ select 2000 $$;

revoke all on function private.passport_stamp_daily_cap() from public;

-- Counts a stamp: once per phone, place and day; «located» once more when the phone says it
-- was there (the first time that day, or when it stamps again from the place). Returns what
-- happened, for tests: recorded · repeated · capped · ignored.
create function private.record_passport_stamp(
  p_tenant_id  uuid,
  p_content_id uuid,
  p_passport   text,
  p_located    boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date;
  v_hash text;
  v_new boolean;
  v_located boolean := false;
begin
  select (now() at time zone t.timezone)::date into v_day
  from public.tenants t where t.id = p_tenant_id;
  if v_day is null or p_content_id is null or p_passport is null then
    return 'ignored';
  end if;
  if coalesce((
    select sum(d.stamps) from public.passport_daily_stamps d
    where d.tenant_id = p_tenant_id and d.day = v_day
  ), 0) >= private.passport_stamp_daily_cap() then
    return 'capped';
  end if;

  v_hash := private.visit_hash(p_tenant_id, v_day, 'passport:' || p_content_id::text || ':' || p_passport);
  insert into private.visit_marks (tenant_id, day, scope, hash)
  values (p_tenant_id, v_day, 'stamp', v_hash)
  on conflict do nothing;
  v_new := found;
  if coalesce(p_located, false) then
    insert into private.visit_marks (tenant_id, day, scope, hash)
    values (p_tenant_id, v_day, 'stamp_located', v_hash)
    on conflict do nothing;
    v_located := found;
  end if;
  if not v_new and not v_located then
    return 'repeated';
  end if;

  if v_new then
    insert into public.passport_daily_stamps as d (tenant_id, day, content_id, stamps, located)
    values (p_tenant_id, v_day, p_content_id, 1, v_located::int)
    on conflict (tenant_id, day, content_id) do update
    set stamps = d.stamps + 1,
        located = d.located + excluded.located;
  else
    -- The same phone, now from the place: its stamp of today was already counted.
    update public.passport_daily_stamps d
    set located = least(d.located + 1, d.stamps)
    where d.tenant_id = p_tenant_id and d.day = v_day and d.content_id = p_content_id;
  end if;
  return 'recorded';
end;
$$;

revoke all on function private.record_passport_stamp(uuid, uuid, text, boolean) from public;

-- The stamp (ADR-057), now also counted. Same answer as before.
create or replace function public.portal_collect_stamp(p_tenant_id uuid, p_code text, p_passport text, p_located boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_place record;
  v_at bigint := floor(extract(epoch from now()))::bigint;
begin
  if p_passport is null or p_passport !~ '^[A-Za-z0-9_-]{22}$' or p_located is null then
    raise exception 'invalid passport or location' using errcode = '22023';
  end if;
  select * into v_place from private.passport_stamp_place(p_tenant_id, p_code);
  if v_place.content_id is null then
    return null;
  end if;
  perform private.passport_key(p_tenant_id);
  perform private.record_passport_stamp(p_tenant_id, v_place.content_id, p_passport, p_located);
  return jsonb_build_object(
    'id', v_place.content_id,
    'slug', v_place.slug,
    'title', v_place.title,
    'at', v_at,
    'located', p_located,
    'signature', private.passport_stamp_signature(p_tenant_id, v_place.content_id, p_passport, v_at, p_located)
  );
end;
$$;

-- ── Reading them ───────────────────────────────────────────────────────────

-- The passport's totals of a period (the municipality's days):
--   places   — stamps and located stamps per place (per day when asked); without days, every
--              place a phone can stamp now appears, with zeros if nobody stamped it;
--   circuits — completed (distinct phones that got a voucher) and redeemed prizes per circuit
--              (per day when asked); without days, every published circuit appears;
--   since    — the first day a stamp was counted (null: none yet), to know what compares.
create function private.passport_statistics(
  p_tenant_id uuid,
  p_from      date,
  p_to        date,
  p_daily     boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_daily boolean := coalesce(p_daily, false);
  v_tz text;
  v_places jsonb;
  v_circuits jsonb;
  v_since date;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select t.timezone into v_tz from public.tenants t where t.id = p_tenant_id;
  if v_tz is null then
    raise exception 'unknown municipality' using errcode = 'P0002';
  end if;

  select min(d.day) into v_since from public.passport_daily_stamps d where d.tenant_id = p_tenant_id;

  -- The places a phone can stamp now: published destinations of a published circuit.
  with stops as (
    select distinct s.content_id
    from public.passport_circuit_stops s
    join public.passport_circuits c
      on c.tenant_id = s.tenant_id and c.id = s.circuit_id and c.status = 'published'
    join public.content_items i
      on i.tenant_id = s.tenant_id and i.id = s.content_id and i.published_revision_id is not null
    where s.tenant_id = p_tenant_id
  ),
  stamped as (
    select case when v_daily then d.day end as day, d.content_id,
           sum(d.stamps)::bigint as stamps, sum(d.located)::bigint as located
    from public.passport_daily_stamps d
    where d.tenant_id = p_tenant_id and d.day between p_from and p_to
    group by 1, d.content_id
  ),
  rows as (
    select st.day, st.content_id, st.stamps, st.located from stamped st
    union all
    select null::date, s.content_id, 0::bigint, 0::bigint
    from stops s
    where not v_daily and not exists (select 1 from stamped x where x.content_id = s.content_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', r.day,
           'contentId', r.content_id,
           'slug', ci.slug,
           'title', coalesce(pub.title, draft.title),
           'stop', exists (select 1 from stops s where s.content_id = r.content_id),
           'stamps', r.stamps,
           'located', r.located
         ) order by r.day nulls first, r.stamps desc, coalesce(pub.title, draft.title)), '[]'::jsonb)
  into v_places
  from rows r
  join public.content_items ci on ci.tenant_id = p_tenant_id and ci.id = r.content_id
  left join public.content_revisions pub
    on pub.tenant_id = p_tenant_id and pub.id = ci.published_revision_id
  left join public.content_revisions draft
    on draft.tenant_id = p_tenant_id and draft.id = ci.draft_revision_id;

  with issued as (
    select v.circuit_id,
           case when v_daily then (v.issued_at at time zone v_tz)::date end as day,
           count(distinct v.passport_hash)::bigint as completed
    from public.passport_vouchers v
    where v.tenant_id = p_tenant_id
      and (v.issued_at at time zone v_tz)::date between p_from and p_to
    group by 1, 2
  ),
  redeemed as (
    select v.circuit_id,
           case when v_daily then (v.redeemed_at at time zone v_tz)::date end as day,
           count(*)::bigint as redeemed
    from public.passport_vouchers v
    where v.tenant_id = p_tenant_id and v.redeemed_at is not null
      and (v.redeemed_at at time zone v_tz)::date between p_from and p_to
    group by 1, 2
  ),
  activity as (
    select coalesce(i.circuit_id, r.circuit_id) as circuit_id, coalesce(i.day, r.day) as day,
           coalesce(i.completed, 0) as completed, coalesce(r.redeemed, 0) as redeemed
    from issued i
    full join redeemed r
      on r.circuit_id = i.circuit_id
     and coalesce(r.day, '1970-01-01'::date) = coalesce(i.day, '1970-01-01'::date)
  ),
  rows as (
    select a.circuit_id, a.day, a.completed, a.redeemed from activity a
    union all
    select c.id, null::date, 0::bigint, 0::bigint
    from public.passport_circuits c
    where c.tenant_id = p_tenant_id and c.status = 'published' and not v_daily
      and not exists (select 1 from activity a where a.circuit_id = c.id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', r.day,
           'circuitId', r.circuit_id,
           'slug', c.slug,
           'name', c.name,
           'published', c.status = 'published',
           'completed', r.completed,
           'redeemed', r.redeemed
         ) order by r.day nulls first, r.completed desc, c.name), '[]'::jsonb)
  into v_circuits
  from rows r
  join public.passport_circuits c on c.tenant_id = p_tenant_id and c.id = r.circuit_id;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'since', v_since, 'places', v_places, 'circuits', v_circuits
  );
end;
$$;

revoke all on function private.passport_statistics(uuid, date, date, boolean) from public;

-- Any member of the municipality (owners and admins with their second factor, ADR-043).
create function public.tenant_passport_statistics(
  p_tenant_id uuid,
  p_from      date,
  p_to        date,
  p_daily     boolean default false
)
returns jsonb
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
  return private.passport_statistics(p_tenant_id, p_from, p_to, p_daily);
end;
$$;

revoke all on function public.tenant_passport_statistics(uuid, date, date, boolean)
  from public, anon, authenticated;
grant execute on function public.tenant_passport_statistics(uuid, date, date, boolean) to authenticated;

-- ── The monthly report (ADR-055) ───────────────────────────────────────────

-- Same as before, plus the passport of the month and of the one it is compared with.
create or replace function worker_api.monthly_report_data(
  p_job_id uuid,
  p_fencing_token bigint,
  p_from date,
  p_to date,
  p_previous_from date,
  p_previous_to date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_month date;
begin
  v_job := private.monthly_report_job(p_job_id, p_fencing_token);
  v_month := (v_job.payload ->> 'month')::date;
  if p_from is distinct from v_month or p_to is null or p_to < p_from
     or p_to >= (v_month + interval '1 month')::date
     or (p_previous_from is null) <> (p_previous_to is null)
     or (p_previous_from is not null and (
       p_previous_to < p_previous_from or p_previous_to >= p_from or p_previous_to - p_previous_from > 31
     )) then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'current', private.visit_statistics(v_job.tenant_id, p_from, p_to, false),
    'previous', case when p_previous_from is null then null
                     else private.visit_statistics(v_job.tenant_id, p_previous_from, p_previous_to, false) end,
    'questions', private.unanswered_questions_between(v_job.tenant_id, p_from, p_to),
    'review', coalesce((select jsonb_agg(to_jsonb(r)) from private.content_review(v_job.tenant_id) r), '[]'::jsonb),
    'snapshot', private.content_snapshot(v_job.tenant_id),
    'activity', private.content_activity(v_job.tenant_id, p_from, p_to),
    'passport', private.passport_statistics(v_job.tenant_id, p_from, p_to, false),
    'passportPrevious', case when p_previous_from is null then null
                             else private.passport_statistics(v_job.tenant_id, p_previous_from, p_previous_to, false) end
  );
end;
$$;

-- ── The Copilot's recommendations (ADR-054) ────────────────────────────────

-- Same as before, plus «circuit»: a passport circuit of this municipality.
create or replace function private.is_valid_recommendation_target(p_tenant_id uuid, p jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p is null or jsonb_typeof(p) = 'null' then
    return true;
  end if;
  if jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  case p ->> 'type'
    when 'content' then
      -- Checked one after the other: a uuid is cast only once its text is a uuid.
      if not (private.has_exact_keys(p, array['type', 'kind', 'contentId', 'proposable'])
              and p ->> 'kind' in ('destination', 'event')
              and jsonb_typeof(p -> 'proposable') = 'boolean'
              and coalesce(p ->> 'contentId' ~ v_uuid, false)) then
        return false;
      end if;
      return exists (
        select 1 from public.content_items i
        where i.tenant_id = p_tenant_id and i.id = (p ->> 'contentId')::uuid
          and i.kind::text = p ->> 'kind'
      );
    when 'scene' then
      if not (private.has_exact_keys(p, array['type', 'kind', 'contentId', 'tourId', 'sceneId'])
              and p ->> 'kind' in ('destination', 'event')
              and coalesce(p ->> 'contentId' ~ v_uuid and p ->> 'tourId' ~ v_uuid
                           and p ->> 'sceneId' ~ v_uuid, false)) then
        return false;
      end if;
      return exists (
        select 1 from public.tours t
        where t.tenant_id = p_tenant_id and t.id = (p ->> 'tourId')::uuid
          and t.content_id = (p ->> 'contentId')::uuid
      );
    when 'circuit' then
      if not (private.has_exact_keys(p, array['type', 'circuitId'])
              and coalesce(p ->> 'circuitId' ~ v_uuid, false)) then
        return false;
      end if;
      return exists (
        select 1 from public.passport_circuits c
        where c.tenant_id = p_tenant_id and c.id = (p ->> 'circuitId')::uuid
      );
    when 'question' then
      return private.has_exact_keys(p, array['type', 'question'])
        and private.is_recommendation_line(p -> 'question', 500);
    when 'agenda' then
      return private.has_exact_keys(p, array['type']);
    else
      return false;
  end case;
end;
$$;

-- Same as before, plus the «passport» source.
create or replace function private.assert_valid_recommendations(p_tenant_id uuid, p_facts jsonb, p_items jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_fact jsonb;
  v_item jsonb;
  v_ids text[] := '{}'::text[];
  v_cited text[];
  v_text text;
begin
  if p_facts is null or jsonb_typeof(p_facts) <> 'array'
     or jsonb_array_length(p_facts) not between 1 and 40 or octet_length(p_facts::text) > 60000 then
    raise exception 'invalid facts' using errcode = '23514', hint = 'facts';
  end if;
  for v_fact in select f from jsonb_array_elements(p_facts) f loop
    if not private.has_exact_keys(v_fact, array['id', 'source', 'text', 'target'])
       or jsonb_typeof(v_fact -> 'id') <> 'string'
       or (v_fact ->> 'id') !~ '^H[1-9][0-9]?$'
       or (v_fact ->> 'id') = any (v_ids)
       or coalesce(v_fact ->> 'source', '') not in ('visits', 'passport', 'questions', 'review', 'agenda')
       or not private.is_recommendation_line(v_fact -> 'text', 400)
       or not private.is_valid_recommendation_target(p_tenant_id, v_fact -> 'target') then
      raise exception 'invalid fact' using errcode = '23514', hint = 'facts';
    end if;
    v_ids := v_ids || (v_fact ->> 'id');
  end loop;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 6 or octet_length(p_items::text) > 16000 then
    raise exception 'invalid recommendations' using errcode = '23514', hint = 'items';
  end if;
  for v_item in select i from jsonb_array_elements(p_items) i loop
    if not private.has_exact_keys(v_item, array['title', 'why', 'facts'])
       or not private.is_recommendation_line(v_item -> 'title', 160)
       or not private.is_recommendation_line(v_item -> 'why', 500)
       or jsonb_typeof(v_item -> 'facts') <> 'array'
       or jsonb_array_length(v_item -> 'facts') not between 1 and 8
       or exists (
         select 1 from jsonb_array_elements(v_item -> 'facts') c
         where jsonb_typeof(c) <> 'string' or (c #>> '{}') <> all (v_ids)
       ) then
      raise exception 'invalid recommendation' using errcode = '23514', hint = 'items';
    end if;
    v_text := (v_item ->> 'title') || ' ' || (v_item ->> 'why');
    if v_text ~* '(https?://|www\.)' then
      raise exception 'a recommendation has a link' using errcode = '23514', hint = 'items';
    end if;
    select array_agg(c #>> '{}') into v_cited from jsonb_array_elements(v_item -> 'facts') c;
    -- Every number written must be in the facts it cites.
    if not private.recommendation_numbers(v_text) <@ private.recommendation_numbers(coalesce((
      select string_agg(f ->> 'text', ' ')
      from jsonb_array_elements(p_facts) f
      where f ->> 'id' = any (v_cited)
    ), '')) then
      raise exception 'a recommendation has a number its facts do not have' using errcode = '23514', hint = 'numbers';
    end if;
  end loop;
end;
$$;
