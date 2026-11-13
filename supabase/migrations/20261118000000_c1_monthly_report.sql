-- C1 · Paso 5 — the monthly report for the town hall (ADR-055). Expand only.
--
-- Every member reads the report of any month in the panel (/o/{slug}/informe), computed from
-- the same numbers as «Estadísticas», «Lo que preguntan los visitantes» and the content
-- review. On the 1st of each month a durable job (reports.monthly) generates the Copilot's
-- recommendations for the month that ended and emails owners and admins a summary with the
-- link. Owners and admins can ask for it again from the panel (up to 3 times a day).
--
--   - The reads the job needs are the panel's own, moved into private functions that take the
--     municipality as an argument; the public functions keep their role checks and call them.
--   - The recommendations the job saves pass the same checks as the panel's (one shared
--     function): known facts of this municipality, and every number in the facts it cites.
--   - monthly_reports keeps per municipality and month only the recommendations, when they
--     were generated and when the email went out. Its facts (which may quote a visitor's
--     question) are forgotten after 90 days, like the questions themselves (ADR-053).

-- ── The reads, as private functions of a municipality ─────────────────────
create function private.visit_statistics(
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
  v_items jsonb;
  v_days jsonb;
  v_origins jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    raise exception 'invalid period' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', g.day,
           'target', g.target,
           'contentId', g.content_id,
           'kind', ci.kind,
           'slug', ci.slug,
           'title', coalesce(pub.title, draft.title),
           'sceneId', g.scene_id,
           'sceneTitle', scene.title,
           'event', g.event,
           'views', g.views,
           'visitors', g.visitors
         ) order by g.day nulls first, g.target, g.event, g.views desc), '[]'::jsonb)
  into v_items
  from (
    select case when v_daily then c.day end as day, c.target, c.content_id, c.scene_id, c.event,
           sum(c.views)::bigint as views, sum(c.visitors)::bigint as visitors
    from public.visit_daily_counts c
    where c.tenant_id = p_tenant_id and c.day between p_from and p_to
    group by 1, c.target, c.content_id, c.scene_id, c.event
  ) g
  left join public.content_items ci
    on ci.tenant_id = p_tenant_id and ci.id = g.content_id
  left join public.content_revisions pub
    on pub.tenant_id = p_tenant_id and pub.id = ci.published_revision_id
  left join public.content_revisions draft
    on draft.tenant_id = p_tenant_id and draft.id = ci.draft_revision_id
  left join lateral (
    select s.title
    from public.tour_scenes s
    join public.tour_revisions r on r.tenant_id = s.tenant_id and r.id = s.tour_revision_id
    join public.tours t on t.tenant_id = r.tenant_id and t.id = r.tour_id
    where g.scene_id is not null and s.tenant_id = p_tenant_id and s.scene_id = g.scene_id
    order by coalesce(t.published_revision_id = r.id, false) desc, r.revision_no desc
    limit 1
  ) scene on true;

  -- Distinct visitors of the portal per day: the origin counts (one mark per visitor and day).
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', d.day, 'views', d.views, 'visitors', d.visitors
         ) order by d.day), '[]'::jsonb)
  into v_days
  from (
    select coalesce(v.day, o.day) as day, coalesce(v.views, 0) as views,
           coalesce(o.visitors, 0) as visitors
    from (
      select c.day, sum(c.views)::bigint as views
      from public.visit_daily_counts c
      where c.tenant_id = p_tenant_id and c.day between p_from and p_to and c.event = 'view'
      group by c.day
    ) v
    full join (
      select o.day, sum(o.visitors)::bigint as visitors
      from public.visit_daily_origins o
      where o.tenant_id = p_tenant_id and o.day between p_from and p_to
      group by o.day
    ) o on o.day = v.day
  ) d;

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', g.day, 'country', g.country, 'city', g.city,
           'views', g.views, 'visitors', g.visitors
         ) order by g.day nulls first, g.views desc, g.country, g.city), '[]'::jsonb)
  into v_origins
  from (
    select case when v_daily then o.day end as day, o.country, o.city,
           sum(o.views)::bigint as views, sum(o.visitors)::bigint as visitors
    from public.visit_daily_origins o
    where o.tenant_id = p_tenant_id and o.day between p_from and p_to
    group by 1, o.country, o.city
  ) g;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'items', v_items, 'days', v_days, 'origins', v_origins
  );
end;
$$;

create function private.unanswered_questions_between(p_tenant_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_to date;
  v_from date;
  v_since date;
  v_total bigint;
  v_people bigint;
  v_groups jsonb;
begin

  v_from := p_from;
  v_to := p_to;

  select min(q.day) into v_since from public.unanswered_questions q where q.tenant_id = p_tenant_id;

  select count(*), count(distinct (q.day, coalesce(r.visitor_hash, q.id::text)))
  into v_total, v_people
  from public.unanswered_questions q
  join public.ai_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
  where q.tenant_id = p_tenant_id and q.day between v_from and v_to;

  with asked as (
    select q.*, coalesce(r.visitor_hash, q.id::text) as who
    from public.unanswered_questions q
    join public.ai_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
    where q.tenant_id = p_tenant_id and q.day between v_from and v_to
  ),
  grouped as (
    select a.question_key,
           count(*)::bigint as times,
           count(distinct (a.day, a.who))::bigint as people,
           min(a.asked_at) as first_asked,
           max(a.asked_at) as last_asked,
           max(a.day) as last_day,
           array_agg(distinct a.lang order by a.lang) as langs,
           (array_agg(a.question_text order by a.asked_at desc))[1] as question_text
    from asked a
    group by a.question_key
    order by times desc, people desc, last_asked desc
    limit 200
  ),
  pages as (
    select a.question_key, a.page_kind, a.content_id, a.scene_id, count(*)::bigint as times,
           row_number() over (
             partition by a.question_key
             order by count(*) desc, a.page_kind, a.content_id nulls last, a.scene_id nulls last
           ) as rank
    from asked a
    where a.question_key in (select g.question_key from grouped g)
    group by a.question_key, a.page_kind, a.content_id, a.scene_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', g.question_key,
           'text', g.question_text,
           'times', g.times,
           'people', g.people,
           'firstAsked', g.first_asked,
           'lastAsked', g.last_asked,
           'lastDay', g.last_day,
           'langs', to_jsonb(g.langs),
           'pages', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'pageKind', p.page_kind,
                      'contentId', p.content_id,
                      'kind', ci.kind,
                      'slug', ci.slug,
                      'title', coalesce(pub.title, draft.title),
                      'sceneTitle', scene.title,
                      'times', p.times
                    ) order by p.rank)
             from pages p
             left join public.content_items ci
               on ci.tenant_id = p_tenant_id and ci.id = p.content_id
             left join public.content_revisions pub
               on pub.tenant_id = p_tenant_id and pub.id = ci.published_revision_id
             left join public.content_revisions draft
               on draft.tenant_id = p_tenant_id and draft.id = ci.draft_revision_id
             left join lateral (
               select s.title
               from public.tour_scenes s
               join public.tour_revisions r on r.tenant_id = s.tenant_id and r.id = s.tour_revision_id
               join public.tours t on t.tenant_id = r.tenant_id and t.id = r.tour_id
               where p.scene_id is not null and s.tenant_id = p_tenant_id and s.scene_id = p.scene_id
               order by coalesce(t.published_revision_id = r.id, false) desc, r.revision_no desc
               limit 1
             ) scene on true
             where p.question_key = g.question_key and p.rank <= 3
           ), '[]'::jsonb)
         ) order by g.times desc, g.people desc, g.last_asked desc), '[]'::jsonb)
  into v_groups
  from grouped g;

  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'since', v_since,
    'total', v_total, 'people', v_people, 'groups', v_groups
  );
end;
$$;

create function private.content_review(p_tenant_id uuid)
returns table (
  kind text,
  content_id uuid,
  slug text,
  tour_id uuid,
  scene_id uuid,
  title text,
  scene_title text,
  status text,
  issues text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin

  return query
  with items as (
    select i.id, i.kind::text as kind, i.slug,
           i.published_revision_id is not null as published,
           i.draft_revision_id is not null as has_draft,
           r.id as revision_id, r.title, r.summary, r.body, r.latitude,
           r.starts_local, r.opening_hours,
           private.rich_text_length(r.body) as body_length,
           exists (select 1 from public.media_references m where m.revision_id = r.id and m.purpose = 'cover') as has_cover,
           exists (
             select 1 from public.tours t
             where t.tenant_id = i.tenant_id and t.content_id = i.id and t.published_revision_id is not null
           ) as has_tour,
           i.kind = 'event' and r.starts_local is not null
             and private.event_ends_at(r.ends_local, r.all_day, tn.timezone) < now() as ended
    from public.content_items i
    join public.tenants tn on tn.id = i.tenant_id
    join public.content_revisions r on r.id = coalesce(i.draft_revision_id, i.published_revision_id)
    where i.tenant_id = p_tenant_id and i.kind in ('destination', 'event')
  ),
  item_issues as (
    select it.*, array_remove(array[
      case when not it.published then 'never_published' end,
      case when it.published and it.has_draft then 'unpublished_changes' end,
      case when it.summary = '' then 'summary_missing'
           when char_length(it.summary) < 60 then 'summary_short' end,
      case when it.body_length = 0 then 'body_missing'
           when it.body_length < 300 then 'body_short' end,
      case when not it.has_cover then 'cover_missing' end,
      case when it.latitude is null then 'location_missing' end,
      case when it.kind = 'destination' and it.opening_hours is null then 'hours_missing' end,
      case when it.kind = 'event' and it.starts_local is null then 'schedule_missing' end,
      case when it.kind = 'destination' and not it.has_tour then 'tour_missing' end
    ], null) as found
    from items it
    where not it.ended
  )
  select ii.kind, ii.id, ii.slug, null::uuid, null::uuid, ii.title, null::text,
         case when not ii.published then 'draft' when ii.has_draft then 'changed' else 'published' end,
         ii.found
  from item_issues ii
  where cardinality(ii.found) > 0
  union all
  -- Scenes without a description: the tour guide has nothing to tell (ADR-040).
  select i.kind::text, i.id, i.slug, t.id, s.scene_id, i_rev.title, s.title,
         case when t.published_revision_id is null then 'draft'
              when t.draft_revision_id is not null then 'changed' else 'published' end,
         array['scene_description_missing']
  from public.tours t
  join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
  join public.content_revisions i_rev on i_rev.id = coalesce(i.draft_revision_id, i.published_revision_id)
  join public.tour_scenes s on s.tour_revision_id = coalesce(t.draft_revision_id, t.published_revision_id)
  where t.tenant_id = p_tenant_id and s.description = ''
  order by 1, 6, 7 nulls first;
end;
$$;

create function private.content_snapshot(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin

  select jsonb_build_object(
    'timezone', tn.timezone,
    'items', coalesce((
      select jsonb_agg(x.item order by x.kind, x.title)
      from (
        select i.kind::text as kind, r.title,
               jsonb_build_object(
                 'kind', i.kind,
                 'contentId', i.id,
                 'slug', i.slug,
                 'title', r.title,
                 'summary', r.summary,
                 'status', case when i.published_revision_id is null then 'draft'
                                when i.draft_revision_id is not null then 'changed' else 'published' end,
                 'schedule', case when i.kind = 'event' and r.starts_local is not null
                                  then private.event_schedule_json(r.starts_local, r.ends_local, r.all_day) end,
                 'ended', i.kind = 'event' and r.starts_local is not null
                          and private.event_ends_at(r.ends_local, r.all_day, tn.timezone) < now(),
                 'tour', (
                   select jsonb_build_object(
                     'tourId', t.id,
                     'status', case when t.published_revision_id is null then 'draft'
                                    when t.draft_revision_id is not null then 'changed' else 'published' end,
                     'scenes', (select count(*) from public.tour_scenes s
                                where s.tour_revision_id = coalesce(t.draft_revision_id, t.published_revision_id)))
                   from public.tours t where t.tenant_id = i.tenant_id and t.content_id = i.id)
               ) as item
        from public.content_items i
        join public.content_revisions r on r.id = coalesce(i.draft_revision_id, i.published_revision_id)
        where i.tenant_id = p_tenant_id and i.kind in ('destination', 'event')
        order by i.updated_at desc
        limit 200
      ) x
    ), '[]'::jsonb)
  ) into v_result
  from public.tenants tn where tn.id = p_tenant_id;
  return v_result;
end;
$$;

revoke all on function private.visit_statistics(uuid, date, date, boolean) from public;
revoke all on function private.unanswered_questions_between(uuid, date, date) from public;
revoke all on function private.content_review(uuid) from public;
revoke all on function private.content_snapshot(uuid) from public;

-- The public reads keep their checks and call the private ones (same answers as before).
create or replace function public.tenant_visit_statistics(
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
  return private.visit_statistics(p_tenant_id, p_from, p_to, p_daily);
end;
$$;

create or replace function public.tenant_unanswered_questions(p_tenant_id uuid, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_to date;
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  if p_days is null or p_days not in (7, 30, 90) then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select (now() at time zone t.timezone)::date into v_to from public.tenants t where t.id = p_tenant_id;
  return private.unanswered_questions_between(p_tenant_id, v_to - (p_days - 1), v_to);
end;
$$;

-- The questions of any period of up to 92 days (the report's month), for any member.
create function public.tenant_unanswered_questions_between(p_tenant_id uuid, p_from date, p_to date)
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
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 92 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return private.unanswered_questions_between(p_tenant_id, p_from, p_to);
end;
$$;

revoke all on function public.tenant_unanswered_questions_between(uuid, date, date) from public, anon, authenticated;
grant execute on function public.tenant_unanswered_questions_between(uuid, date, date) to authenticated;

create or replace function public.copilot_content_review(p_tenant_id uuid)
returns table (
  kind text,
  content_id uuid,
  slug text,
  tour_id uuid,
  scene_id uuid,
  title text,
  scene_title text,
  status text,
  issues text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]);
  return query select * from private.content_review(p_tenant_id);
end;
$$;

create or replace function public.copilot_snapshot(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]);
  return private.content_snapshot(p_tenant_id);
end;
$$;

-- What was published in a period (days of the municipality): each destination, event or
-- knowledge text, and each tour, with how many times and whether it was its first time.
create function private.content_activity(p_tenant_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select (p_from::timestamp at time zone t.timezone) as t0,
           ((p_to + 1)::timestamp at time zone t.timezone) as t1
    from public.tenants t where t.id = p_tenant_id
  ),
  published as (
    select r.content_id, r.sealed_at, false as tour
    from public.content_revisions r, bounds b
    where r.tenant_id = p_tenant_id and r.state = 'sealed'
      and r.sealed_at >= b.t0 and r.sealed_at < b.t1
    union all
    select t.content_id, r.sealed_at, true
    from public.tour_revisions r
    join public.tours t on t.tenant_id = r.tenant_id and t.id = r.tour_id, bounds b
    where r.tenant_id = p_tenant_id and r.state = 'sealed'
      and r.sealed_at >= b.t0 and r.sealed_at < b.t1
  ),
  grouped as (
    select p.content_id, p.tour, count(*) as times, max(p.sealed_at) as last_at
    from published p
    group by p.content_id, p.tour
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'total', (select count(*) from published),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'contentId', g.content_id,
               'kind', ci.kind,
               'title', cur.title,
               'tour', g.tour,
               'times', g.times,
               'first', case when g.tour then not exists (
                   select 1 from public.tour_revisions o
                   join public.tours t on t.tenant_id = o.tenant_id and t.id = o.tour_id, bounds b
                   where o.tenant_id = p_tenant_id and t.content_id = g.content_id
                     and o.state = 'sealed' and o.sealed_at < b.t0
                 ) else not exists (
                   select 1 from public.content_revisions o, bounds b
                   where o.tenant_id = p_tenant_id and o.content_id = g.content_id
                     and o.state = 'sealed' and o.sealed_at < b.t0
                 ) end,
               'publishedAt', g.last_at
             ) order by g.last_at desc)
      from (select * from grouped order by last_at desc limit 100) g
      join public.content_items ci on ci.tenant_id = p_tenant_id and ci.id = g.content_id
      join public.content_revisions cur
        on cur.tenant_id = p_tenant_id
       and cur.id = coalesce(ci.published_revision_id, ci.draft_revision_id)
    ), '[]'::jsonb)
  );
$$;

revoke all on function private.content_activity(uuid, date, date) from public;

create function public.tenant_content_activity(p_tenant_id uuid, p_from date, p_to date)
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
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 92 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return private.content_activity(p_tenant_id, p_from, p_to);
end;
$$;

revoke all on function public.tenant_content_activity(uuid, date, date) from public, anon, authenticated;
grant execute on function public.tenant_content_activity(uuid, date, date) to authenticated;

-- ── The recommendations' checks, shared ───────────────────────────────────

-- The checks every saved set of recommendations passes (ADR-054): known facts with a target
-- of this municipality, one to six recommendations citing them, no links, and every number
-- written in the facts it cites.
create function private.assert_valid_recommendations(p_tenant_id uuid, p_facts jsonb, p_items jsonb)
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
       or coalesce(v_fact ->> 'source', '') not in ('visits', 'questions', 'review', 'agenda')
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

revoke all on function private.assert_valid_recommendations(uuid, jsonb, jsonb) from public;

create or replace function public.save_copilot_recommendations(
  p_tenant_id uuid,
  p_ai_request_id uuid,
  p_period_from date,
  p_period_to date,
  p_facts jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]);

  if p_period_from is null or p_period_to is null
     or p_period_to < p_period_from or p_period_to - p_period_from > 400 then
    raise exception 'invalid period' using errcode = '22023';
  end if;

  perform private.assert_valid_recommendations(p_tenant_id, p_facts, p_items);

  -- The model's answer behind it: a copilot request of this person, here, in the last hour.
  if not exists (
    select 1 from public.ai_requests a
    where a.tenant_id = p_tenant_id and a.id = p_ai_request_id
      and a.profile = 'copilot' and a.status = 'completed'
      and a.actor_id = (select auth.uid())
      and a.created_at > now() - interval '1 hour'
  ) then
    raise exception 'no copilot request behind these recommendations' using errcode = '23514', hint = 'request';
  end if;

  delete from public.copilot_recommendations r where r.tenant_id = p_tenant_id;
  insert into public.copilot_recommendations (
    tenant_id, period_from, period_to, facts, items, ai_request_id, created_by
  ) values (
    p_tenant_id, p_period_from, p_period_to, p_facts, p_items, p_ai_request_id, (select auth.uid())
  ) returning id into v_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'copilot.recommendations_generated', 'copilot_recommendations', v_id, null, 'success',
          jsonb_build_object('recommendations', jsonb_array_length(p_items), 'facts', jsonb_array_length(p_facts),
                             'from', p_period_from, 'to', p_period_to));

  return v_id;
end;
$$;


-- ── The monthly report ─────────────────────────────────────────────────────

-- The month a report covers and its period: from its 1st to its last day, or to today for the
-- current month (days of the municipality). A month in the future is invalid.
create function private.monthly_report_period(p_tenant_id uuid, p_month date)
returns table (period_from date, period_to date, today date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  select (now() at time zone t.timezone)::date into v_today from public.tenants t where t.id = p_tenant_id;
  if v_today is null or p_month is null or extract(day from p_month) <> 1
     or p_month > date_trunc('month', v_today)::date
     or p_month < (date_trunc('month', v_today) - interval '24 months')::date then
    raise exception 'invalid month' using errcode = '22023';
  end if;
  return query
  select p_month, least((p_month + interval '1 month')::date - 1, v_today), v_today;
end;
$$;

revoke all on function private.monthly_report_period(uuid, date) from public;

-- One row per municipality and month: the Copilot's recommendations of the report (or why
-- there are none) and when the email went out. The numbers are never stored: the page and
-- the email compute them from the same functions as «Estadísticas».
create table public.monthly_reports (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  month            date not null,
  period_from      date not null,
  period_to        date not null,
  facts            jsonb,
  items            jsonb,
  -- Why there are no recommendations: the gateway's refusal or «nothing».
  note             text,
  ai_request_id    uuid,
  generated_job_id uuid,
  generated_at     timestamptz not null default now(),
  forgotten_at     timestamptz,
  mailed_job_id    uuid,
  mailed_at        timestamptz,
  mailed_count     integer,

  constraint monthly_reports_tenant_month_key unique (tenant_id, month),
  constraint monthly_reports_month check (extract(day from month) = 1),
  constraint monthly_reports_period check (
    period_from = month and period_to >= period_from and period_to < (month + interval '1 month')::date
  ),
  constraint monthly_reports_items check ((facts is null) = (items is null)),
  constraint monthly_reports_note check (note is null or note ~ '^[a-z_]{1,40}$'),
  constraint monthly_reports_something check (
    items is not null or note is not null or forgotten_at is not null
  ),
  constraint monthly_reports_mailed check ((mailed_at is null) = (mailed_count is null)),
  constraint monthly_reports_mailed_count check (mailed_count is null or mailed_count between 0 and 200)
);

alter table public.monthly_reports enable row level security;
revoke all on public.monthly_reports from public, anon, authenticated, service_role;

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values ('reports.monthly', 'mail', 4, 120, 180, 1, 'Informe mensual del municipio');

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
    -- {"month": "YYYY-MM-01", "manual": bool}: the job's tenant is the report's (ADR-055).
    when p_kind = 'reports.monthly' then
      jsonb_typeof(p_payload) = 'object'
      and private.has_exact_keys(p_payload, array['month', 'manual'])
      and coalesce(p_payload ->> 'month', '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-01$'
      and jsonb_typeof(p_payload -> 'manual') = 'boolean'
    else false
  end;
$$;

-- Every day: the month that ended, for each municipality online, during the first three days
-- of its month (a missed day is caught up; the logical key keeps it to one). Not for a month
-- before the municipality existed.
create function private.enqueue_monthly_reports(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant record;
  v_today date;
  v_month date;
  v_created integer := 0;
  v_new boolean;
begin
  for v_tenant in select t.id, t.timezone, t.created_at from public.tenants t where t.status = 'active' order by t.id loop
    v_today := (p_now at time zone v_tenant.timezone)::date;
    continue when extract(day from v_today) > 3;
    v_month := (date_trunc('month', v_today) - interval '1 month')::date;
    continue when v_month < date_trunc('month', v_tenant.created_at at time zone v_tenant.timezone)::date;
    select e.created into v_new
    from private.enqueue_job(
      v_tenant.id, 'reports.monthly', 'monthly:' || to_char(v_month, 'YYYY-MM'),
      jsonb_build_object('month', to_char(v_month, 'YYYY-MM-DD'), 'manual', false),
      'tenant', v_tenant.id
    ) e;
    if v_new then
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end;
$$;

revoke all on function private.enqueue_monthly_reports(timestamptz) from public;

-- «Enviar este informe ahora por correo»: owners and admins, up to 3 times a day per
-- municipality. Generates the month's recommendations again and emails owners and admins.
create function public.request_monthly_report(p_tenant_id uuid, p_month date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job uuid;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  perform 1 from private.monthly_report_period(p_tenant_id, p_month);
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id and t.status = 'active') then
    raise exception 'the municipality is not online' using errcode = 'PT409', hint = 'status';
  end if;
  if (
    select count(*) from public.background_jobs j
    where j.tenant_id = p_tenant_id and j.kind = 'reports.monthly'
      and (j.payload ->> 'manual')::boolean and j.created_at > now() - interval '1 day'
  ) >= 3 then
    raise exception 'too many reports today' using errcode = 'PT429';
  end if;

  select e.job_id into v_job
  from private.enqueue_job(
    p_tenant_id, 'reports.monthly',
    'monthly:' || to_char(p_month, 'YYYY-MM') || ':manual:' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
    jsonb_build_object('month', to_char(p_month, 'YYYY-MM-DD'), 'manual', true),
    'tenant', p_tenant_id
  ) e;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'report.monthly_requested', 'background_job', v_job, null, 'success',
          jsonb_build_object('month', to_char(p_month, 'YYYY-MM')));
  return v_job;
end;
$$;

revoke all on function public.request_monthly_report(uuid, date) from public, anon, authenticated;
grant execute on function public.request_monthly_report(uuid, date) to authenticated;

-- What the page shows of a month's report besides its numbers (any member): its period, the
-- recommendations (or why there are none), when the email went out and whether one is on its way.
create function public.tenant_monthly_report(p_tenant_id uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_report public.monthly_reports;
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  select * into v_period from private.monthly_report_period(p_tenant_id, p_month);
  select * into v_report from public.monthly_reports r where r.tenant_id = p_tenant_id and r.month = p_month;
  return jsonb_build_object(
    'month', p_month,
    'from', v_period.period_from,
    'to', v_period.period_to,
    'today', v_period.today,
    'firstDay', (select min(c.day) from public.visit_daily_counts c where c.tenant_id = p_tenant_id),
    'report', case when v_report.id is null then null else jsonb_build_object(
      'generatedAt', v_report.generated_at,
      'from', v_report.period_from,
      'to', v_report.period_to,
      'facts', v_report.facts,
      'items', v_report.items,
      'note', v_report.note,
      'forgotten', v_report.forgotten_at is not null,
      'mailedAt', v_report.mailed_at,
      'mailedCount', v_report.mailed_count
    ) end,
    'pending', exists (
      select 1 from public.background_jobs j
      where j.tenant_id = p_tenant_id and j.kind = 'reports.monthly'
        and j.status in ('pending', 'running') and j.payload ->> 'month' = to_char(p_month, 'YYYY-MM-DD')
    ),
    'requestsToday', (
      select count(*) from public.background_jobs j
      where j.tenant_id = p_tenant_id and j.kind = 'reports.monthly'
        and (j.payload ->> 'manual')::boolean and j.created_at > now() - interval '1 day'
    )
  );
end;
$$;

revoke all on function public.tenant_monthly_report(uuid, date) from public, anon, authenticated;
grant execute on function public.tenant_monthly_report(uuid, date) to authenticated;

-- ── worker_api: the report's job, always under its lease ──────────────────
-- Everything is read and written for the job's own municipality and the payload's month.

create function private.monthly_report_job(p_job_id uuid, p_fencing_token bigint)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'reports.monthly' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  return v_job;
end;
$$;

revoke all on function private.monthly_report_job(uuid, bigint) from public;

-- What the job works on: the municipality (or «skip» when it is not online or the month is
-- not valid any more), the period, who receives the email, and what this same job already did
-- (a retry neither asks the model again nor sends the email twice).
create function worker_api.monthly_report_source(p_job_id uuid, p_fencing_token bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_tenant public.tenants;
  v_month date;
  v_period record;
  v_report public.monthly_reports;
begin
  v_job := private.monthly_report_job(p_job_id, p_fencing_token);
  select * into v_tenant from public.tenants t where t.id = v_job.tenant_id;
  if v_tenant.status is distinct from 'active' then
    return jsonb_build_object('state', 'skip', 'reason', 'not_online');
  end if;
  v_month := (v_job.payload ->> 'month')::date;
  begin
    select * into v_period from private.monthly_report_period(v_tenant.id, v_month);
  exception when sqlstate '22023' then
    return jsonb_build_object('state', 'skip', 'reason', 'invalid_month');
  end;
  select * into v_report from public.monthly_reports r where r.tenant_id = v_tenant.id and r.month = v_month;
  return jsonb_build_object(
    'state', 'run',
    'tenantId', v_tenant.id,
    'name', v_tenant.display_name,
    'slug', v_tenant.slug,
    'timezone', v_tenant.timezone,
    'month', v_month,
    'from', v_period.period_from,
    'to', v_period.period_to,
    'today', v_period.today,
    'firstDay', (select min(c.day) from public.visit_daily_counts c where c.tenant_id = v_tenant.id),
    'manual', (v_job.payload ->> 'manual')::boolean,
    'recipients', coalesce((
      select jsonb_agg(distinct u.email::text)
      from public.memberships m
      join auth.users u on u.id = m.user_id
      where m.tenant_id = v_tenant.id and m.status = 'active' and m.role in ('owner', 'admin')
        and u.email is not null
    ), '[]'::jsonb),
    'generated', v_report.generated_job_id is not distinct from v_job.id and v_report.id is not null,
    -- What a previous attempt of this job kept (for the email of a retry).
    'items', case when v_report.generated_job_id = v_job.id then v_report.items end,
    'note', case when v_report.generated_job_id = v_job.id then v_report.note end,
    'mailed', v_report.mailed_job_id is not distinct from v_job.id and v_report.id is not null
  );
end;
$$;

-- The numbers of the period (and of the one it is compared with), the month's unanswered
-- questions, the content review, the editors' view of the content and what was published:
-- the same functions «Estadísticas» and the Copilot read, for the job's municipality.
create function worker_api.monthly_report_data(
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
    'activity', private.content_activity(v_job.tenant_id, p_from, p_to)
  );
end;
$$;

-- Keeps the month's recommendations (or why there are none), replacing what an earlier job
-- left. The recommendations pass the same checks as the panel's, and rest on a completed
-- Copilot request of this municipality made by the platform (no person) in the last hour.
create function worker_api.save_monthly_report(
  p_job_id uuid,
  p_fencing_token bigint,
  p_to date,
  p_ai_request_id uuid,
  p_facts jsonb,
  p_items jsonb,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_month date;
  v_id uuid;
begin
  v_job := private.monthly_report_job(p_job_id, p_fencing_token);
  v_month := (v_job.payload ->> 'month')::date;
  if p_to is null or p_to < v_month or p_to >= (v_month + interval '1 month')::date then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  if p_items is null then
    if p_facts is not null or p_note is null or p_note !~ '^[a-z_]{1,40}$' then
      raise exception 'a report without recommendations says why' using errcode = '23514', hint = 'note';
    end if;
  else
    if p_note is not null then
      raise exception 'a report with recommendations has no note' using errcode = '23514', hint = 'note';
    end if;
    perform private.assert_valid_recommendations(v_job.tenant_id, p_facts, p_items);
    if not exists (
      select 1 from public.ai_requests a
      where a.tenant_id = v_job.tenant_id and a.id = p_ai_request_id
        and a.profile = 'copilot' and a.status = 'completed'
        and a.actor_id is null
        and a.created_at > now() - interval '1 hour'
    ) or exists (
      select 1 from public.monthly_reports r
      where r.ai_request_id = p_ai_request_id
        and not (r.tenant_id = v_job.tenant_id and r.month = v_month)
    ) then
      raise exception 'no copilot request behind these recommendations' using errcode = '23514', hint = 'request';
    end if;
  end if;

  insert into public.monthly_reports as r (
    tenant_id, month, period_from, period_to, facts, items, note, ai_request_id,
    generated_job_id, generated_at, forgotten_at
  ) values (
    v_job.tenant_id, v_month, v_month, p_to, p_facts, p_items, p_note,
    case when p_items is null then null else p_ai_request_id end,
    v_job.id, now(), null
  )
  on conflict (tenant_id, month) do update set
    period_to = excluded.period_to,
    facts = excluded.facts,
    items = excluded.items,
    note = excluded.note,
    ai_request_id = excluded.ai_request_id,
    generated_job_id = excluded.generated_job_id,
    generated_at = excluded.generated_at,
    forgotten_at = null
  returning r.id into v_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', v_job.tenant_id, null, 'report.monthly_generated', 'monthly_report', v_id, null, 'success',
          jsonb_build_object('month', to_char(v_month, 'YYYY-MM'),
                             'recommendations', coalesce(jsonb_array_length(p_items), 0),
                             'note', p_note));
  return v_id;
end;
$$;

-- The email went out to this many people: recorded once per job.
create function worker_api.mark_monthly_report_mailed(p_job_id uuid, p_fencing_token bigint, p_count integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_month date;
  v_id uuid;
begin
  v_job := private.monthly_report_job(p_job_id, p_fencing_token);
  v_month := (v_job.payload ->> 'month')::date;
  if p_count is null or p_count not between 0 and 200 then
    raise exception 'invalid count' using errcode = '22023';
  end if;
  update public.monthly_reports r
  set mailed_job_id = v_job.id, mailed_at = now(), mailed_count = p_count
  where r.tenant_id = v_job.tenant_id and r.month = v_month
    and r.mailed_job_id is distinct from v_job.id
  returning r.id into v_id;
  if v_id is null then
    return case when exists (
      select 1 from public.monthly_reports r
      where r.tenant_id = v_job.tenant_id and r.month = v_month and r.mailed_job_id = v_job.id
    ) then 'already_mailed' else 'missing' end;
  end if;
  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', v_job.tenant_id, null, 'report.monthly_mailed', 'monthly_report', v_id, null, 'success',
          jsonb_build_object('month', to_char(v_month, 'YYYY-MM'), 'recipients', p_count));
  return 'marked';
end;
$$;

revoke all on function worker_api.monthly_report_source(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function worker_api.monthly_report_data(uuid, bigint, date, date, date, date) from public, anon, authenticated, service_role;
revoke all on function worker_api.save_monthly_report(uuid, bigint, date, uuid, jsonb, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function worker_api.mark_monthly_report_mailed(uuid, bigint, integer) from public, anon, authenticated, service_role;
grant execute on function worker_api.monthly_report_source(uuid, bigint) to rikuy_worker;
grant execute on function worker_api.monthly_report_data(uuid, bigint, date, date, date, date) to rikuy_worker;
grant execute on function worker_api.save_monthly_report(uuid, bigint, date, uuid, jsonb, jsonb, text) to rikuy_worker;
grant execute on function worker_api.mark_monthly_report_mailed(uuid, bigint, integer) to rikuy_worker;

-- The recommendations (and the facts, which may quote a visitor's question) are forgotten
-- after 90 days, like the questions themselves (ADR-053); the row keeps when it was mailed.
create function private.forget_old_monthly_recommendations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.monthly_reports r
  set facts = null, items = null, note = null, forgotten_at = now()
  where r.generated_at < now() - interval '90 days' and r.forgotten_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.forget_old_monthly_recommendations() from public;

select cron.schedule('rikuy-monthly-reports', '37 11 * * *', $$select private.enqueue_monthly_reports()$$);
select cron.schedule(
  'rikuy-forget-monthly-recommendations', '47 8 * * *',
  $$select private.forget_old_monthly_recommendations()$$
);
