-- C1 · Paso 2 — «Estadísticas» for the municipality's team (ADR-052). Expand only.
--
-- The daily totals of C1 · Paso 1 (ADR-051) become readable by every member of the
-- municipality (owners, admins, editors and analysts), through two functions only: the
-- tables keep RLS without policies. The panel picks the period and compares it with the one
-- before; the functions only add up what they are asked for, with the current name of each
-- place and scene. Nothing in these totals identifies a visitor.

-- The municipality's clock and the first day with any count (so the panel does not compare
-- with days that were never counted).
create function public.tenant_visit_calendar(p_tenant_id uuid)
returns table (timezone text, first_day date)
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
  select t.timezone,
         (select min(c.day) from public.visit_daily_counts c where c.tenant_id = t.id)
  from public.tenants t
  where t.id = p_tenant_id;
end;
$$;

-- The totals of [p_from, p_to] (days of the municipality, both included, at most 400 days):
--   items:   per page, place, scene and event (and per day with p_daily);
--   days:    page views and distinct visitors of the whole portal, per day;
--   origins: per country and city (and per day with p_daily).
-- A place is named by its published version (or its draft, if it was never published); a
-- scene by the published version of its tour (or the newest one that has it). Deleted places take their counts with
-- them (ADR-051); a deleted tour leaves its scenes without a name.
create function public.tenant_visit_statistics(
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
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
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

revoke all on function public.tenant_visit_calendar(uuid) from public, anon, authenticated;
revoke all on function public.tenant_visit_statistics(uuid, date, date, boolean)
  from public, anon, authenticated;
grant execute on function public.tenant_visit_calendar(uuid) to authenticated;
grant execute on function public.tenant_visit_statistics(uuid, date, date, boolean) to authenticated;
