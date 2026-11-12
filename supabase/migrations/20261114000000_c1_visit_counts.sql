-- C1 · Paso 1 — anonymous visit counts per municipality (ADR-051). Expand only.
--
-- The portal's pages come from the CDN cache, so the visitor's browser tells the server what
-- it opened (a page, a scene of a tour, «Cómo llegar», «Compartir», «Añadir al calendario» or
-- a QR scan). Only daily totals are kept, forever: per page or place, and per approximate
-- origin (country and city, estimated by the CDN from the connection). Nothing about any one
-- visitor is kept: to count unique visitors per day, sha256(salt of the day ‖ municipality ‖
-- address and browser) marks who was already counted today; the marks and the salt are
-- deleted two days later, so days and municipalities can never be linked. No cookies.
--
-- Written only by the platform's workload connection (rikuy_worker), never by a session.

-- ── Daily totals ────────────────────────────────────────────────────────────

create table public.visit_daily_counts (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  day        date not null,
  target     text not null,
  content_id uuid,
  scene_id   uuid,
  event      text not null,
  views      integer not null default 0,
  visitors   integer not null default 0,
  constraint visit_daily_counts_key unique nulls not distinct
    (tenant_id, day, target, content_id, scene_id, event),
  constraint visit_daily_counts_content_fk foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete cascade,
  constraint visit_daily_counts_target check (target in (
    'home', 'destinations', 'agenda', 'map', 'general_tour',
    'destination', 'event', 'destination_tour', 'event_tour'
  )),
  constraint visit_daily_counts_event check (event in (
    'view', 'scene', 'directions', 'share', 'calendar', 'qr'
  )),
  constraint visit_daily_counts_content check (
    (content_id is null) = (target in ('home', 'destinations', 'agenda', 'map', 'general_tour'))
  ),
  constraint visit_daily_counts_scene check (
    (scene_id is not null) = (event = 'scene')
  ),
  constraint visit_daily_counts_nonnegative check (views >= 0 and visitors >= 0 and visitors <= views)
);

create table public.visit_daily_origins (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day       date not null,
  country   text,
  city      text,
  views     integer not null default 0,
  visitors  integer not null default 0,
  constraint visit_daily_origins_key unique nulls not distinct (tenant_id, day, country, city),
  constraint visit_daily_origins_country check (country is null or country ~ '^[A-Z]{2}$'),
  constraint visit_daily_origins_city check (
    city is null or (country is not null and length(city) between 1 and 80 and city !~ '[[:cntrl:]]')
  ),
  constraint visit_daily_origins_nonnegative check (views >= 0 and visitors >= 0 and visitors <= views)
);

alter table public.visit_daily_counts enable row level security;
alter table public.visit_daily_origins enable row level security;
-- No policies and no grants yet: the panel reads them through functions (C1 · Paso 2).
revoke all on table public.visit_daily_counts, public.visit_daily_origins
  from public, anon, authenticated, service_role;

-- ── Who was already counted today ──────────────────────────────────────────

-- One random salt per day; nobody can read it, and it is deleted two days later.
create table private.visit_salts (
  day  date primary key,
  salt text not null
);

create table private.visit_marks (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day       date not null,
  scope     text not null,
  hash      text not null,
  events    integer not null default 1,
  primary key (tenant_id, day, scope, hash),
  constraint visit_marks_hash check (hash ~ '^[0-9a-f]{64}$')
);

revoke all on table private.visit_salts, private.visit_marks from public;

-- Events a single visitor can add to a municipality in one day; past it, nothing is counted
-- (a script hammering the endpoint cannot inflate the totals).
create function private.visit_daily_cap()
returns integer
language sql
immutable
set search_path = ''
as $$ select 500 $$;

create function private.visit_hash(p_tenant_id uuid, p_day date, p_visitor text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salt text;
begin
  insert into private.visit_salts (day, salt)
  values (p_day, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (day) do nothing;
  select s.salt into v_salt from private.visit_salts s where s.day = p_day;
  return encode(
    sha256(convert_to(v_salt || ':' || p_tenant_id::text || ':' || p_visitor, 'UTF8')),
    'hex'
  );
end;
$$;

revoke all on function private.visit_daily_cap() from public;
revoke all on function private.visit_hash(uuid, date, text) from public;

-- ── The workload's API ──────────────────────────────────────────────────────

-- Records one thing a visitor opened or did. Returns what happened, for tests and logs:
--   recorded · ignored (unknown or invalid: municipality not online, place not published,
--   scene not in its published tour, event not allowed there) · capped.
create function worker_api.record_visit(
  p_tenant_id uuid,
  p_target    text,
  p_slug      text,
  p_scene_id  uuid,
  p_event     text,
  p_country   text,
  p_city      text,
  p_visitor   text,
  p_at        timestamptz default now()
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_day date;
  v_content uuid;
  v_kind text;
  v_country text := case when p_country ~ '^[A-Z]{2}$' then p_country end;
  v_city text;
  v_hash text;
  v_events integer;
  v_new_target boolean := false;
  v_new_origin boolean := false;
  v_page_targets constant text[] := array['home', 'destinations', 'agenda', 'map', 'general_tour'];
  v_place_targets constant text[] := array['destination', 'event', 'destination_tour', 'event_tour'];
begin
  -- What may be recorded where.
  if p_target is null or p_event is null
     or not (p_target = any (v_page_targets) or p_target = any (v_place_targets))
     or p_event not in ('view', 'scene', 'directions', 'share', 'calendar', 'qr')
     or (p_event = 'scene' and p_target not in ('destination_tour', 'event_tour'))
     or (p_event = 'scene') <> (p_scene_id is not null)
     or (p_event in ('directions', 'share', 'calendar') and p_target not in ('destination', 'event'))
     or (p_event = 'calendar' and p_target <> 'event')
     or (p_event = 'qr' and p_target not in
         ('destination', 'event', 'destination_tour', 'event_tour', 'general_tour'))
     or ((p_target = any (v_place_targets)) <> (p_slug is not null)) then
    return 'ignored';
  end if;

  select t.timezone into v_timezone
  from public.tenants t
  where t.id = p_tenant_id and t.status = 'active';
  if v_timezone is null then
    return 'ignored';
  end if;
  v_day := (coalesce(p_at, now()) at time zone v_timezone)::date;

  -- A place: published, of this municipality and of the right kind; its tour, published.
  if p_target = any (v_place_targets) then
    v_kind := case when p_target in ('destination', 'destination_tour') then 'destination' else 'event' end;
    select c.id into v_content
    from public.content_items c
    where c.tenant_id = p_tenant_id
      and c.kind::text = v_kind
      and c.slug = p_slug
      and c.published_revision_id is not null;
    if v_content is null then
      return 'ignored';
    end if;
    if p_target in ('destination_tour', 'event_tour') and not exists (
      select 1
      from public.tours tr
      where tr.tenant_id = p_tenant_id
        and tr.content_id = v_content
        and tr.published_revision_id is not null
        and (p_scene_id is null or exists (
          select 1
          from public.tour_scenes s
          where s.tenant_id = p_tenant_id
            and s.tour_revision_id = tr.published_revision_id
            and s.scene_id = p_scene_id
        ))
    ) then
      return 'ignored';
    end if;
  end if;

  -- The visitor, as today's mark (never the address itself).
  if p_visitor is not null and length(btrim(p_visitor)) > 0 then
    v_hash := private.visit_hash(p_tenant_id, v_day, left(p_visitor, 512));
    insert into private.visit_marks as m (tenant_id, day, scope, hash)
    values (p_tenant_id, v_day, 'site', v_hash)
    on conflict (tenant_id, day, scope, hash) do update set events = m.events + 1
    returning m.events into v_events;
    if v_events > private.visit_daily_cap() then
      return 'capped';
    end if;
    insert into private.visit_marks (tenant_id, day, scope, hash)
    values (
      p_tenant_id, v_day,
      concat_ws(':', p_target, coalesce(v_content::text, '-'), coalesce(p_scene_id::text, '-'), p_event),
      v_hash
    )
    on conflict do nothing;
    v_new_target := found;
  end if;

  insert into public.visit_daily_counts as c
    (tenant_id, day, target, content_id, scene_id, event, views, visitors)
  values (p_tenant_id, v_day, p_target, v_content, p_scene_id, p_event, 1, v_new_target::int)
  on conflict on constraint visit_daily_counts_key do update
  set views = c.views + 1,
      visitors = c.visitors + v_new_target::int;

  -- Where visitors come from: counted on page views only.
  if p_event = 'view' then
    if v_country is not null then
      v_city := nullif(btrim(regexp_replace(left(coalesce(p_city, ''), 80), '[[:cntrl:]]', '', 'g')), '');
    end if;
    if v_hash is not null then
      insert into private.visit_marks (tenant_id, day, scope, hash)
      values (p_tenant_id, v_day, 'origin', v_hash)
      on conflict do nothing;
      v_new_origin := found;
    end if;
    insert into public.visit_daily_origins as o (tenant_id, day, country, city, views, visitors)
    values (p_tenant_id, v_day, v_country, v_city, 1, v_new_origin::int)
    on conflict on constraint visit_daily_origins_key do update
    set views = o.views + 1,
        visitors = o.visitors + v_new_origin::int;
  end if;

  return 'recorded';
end;
$$;

revoke all on function worker_api.record_visit(uuid, text, text, uuid, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function worker_api.record_visit(uuid, text, text, uuid, text, text, text, text, timestamptz)
  to rikuy_worker;

-- ── Forgetting who was counted ─────────────────────────────────────────────

create function private.forget_visit_marks()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.visit_marks m where m.day < current_date - 2;
  delete from private.visit_salts s where s.day < current_date - 2;
$$;

revoke all on function private.forget_visit_marks() from public;

select cron.schedule('rikuy-forget-visit-marks', '17 8 * * *', $$select private.forget_visit_marks()$$);
