-- ─────────────────────────────────────────────────────────────────────────────
-- P3 · Paso 5: the portal map.
--
--   * portal_map_places: what a map view shows — published destinations and events that
--     have not ended, with coordinates INSIDE the requested area (GiST index on the
--     geography point), capped, never the whole catalogue.
--   * portal_map_extent: the area that holds them all, to frame the first view.
-- Anonymous, active tenants only, published revisions only. Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

-- Every place a visitor may see on the map (used for the overall extent; the area query
-- below repeats these conditions next to the tables so it can use the spatial index).
create function private.portal_map_candidates(p_tenant_id uuid)
returns table (
  kind text,
  slug text,
  title text,
  summary text,
  latitude double precision,
  longitude double precision,
  location extensions.geography,
  schedule jsonb,
  starts_at timestamptz,
  cover jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.kind::text, i.slug, r.title, r.summary, r.latitude, r.longitude, r.location,
         case when i.kind = 'event'
              then private.event_schedule_json(r.starts_local, r.ends_local, r.all_day) end,
         case when i.kind = 'event' then private.event_starts_at(r.starts_local, t.timezone) end,
         (select private.public_image(m.asset_version_id, m.alt_text)
          from public.media_references m
          where m.revision_id = r.id and m.purpose = 'cover')
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  where i.tenant_id = p_tenant_id
    and r.state = 'sealed'
    and r.location is not null
    and (
      i.kind = 'destination'
      or (i.kind = 'event'
          and r.starts_local is not null
          and private.event_ends_at(r.ends_local, r.all_day, t.timezone) > now())
    );
$$;

revoke all on function private.portal_map_candidates(uuid) from public;

-- Places inside [west, south, east, north] (degrees), destinations and/or events, at most
-- p_limit (1–500). Invalid areas (south > north, west > east, out of range) are refused.
create function public.portal_map_places(
  p_tenant_id uuid,
  p_west double precision,
  p_south double precision,
  p_east double precision,
  p_north double precision,
  p_kinds text[] default array['destination', 'event'],
  p_limit integer default 300
)
returns table (
  kind text,
  slug text,
  title text,
  summary text,
  latitude double precision,
  longitude double precision,
  schedule jsonb,
  starts_at timestamptz,
  cover jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_west is null or p_south is null or p_east is null or p_north is null
     or p_south < -90 or p_north > 90 or p_west < -180 or p_east > 180
     or p_south > p_north or p_west > p_east
     or p_limit is null or p_limit not between 1 and 500
     or p_kinds is null or not (p_kinds <@ array['destination', 'event']) then
    raise exception 'invalid map area' using errcode = '22023';
  end if;
  -- The area filter sits next to the tables so the GiST index on the point is used.
  return query
  select i.kind::text, i.slug, r.title, r.summary, r.latitude, r.longitude,
         case when i.kind = 'event'
              then private.event_schedule_json(r.starts_local, r.ends_local, r.all_day) end,
         case when i.kind = 'event' then private.event_starts_at(r.starts_local, t.timezone) end,
         (select private.public_image(m.asset_version_id, m.alt_text)
          from public.media_references m
          where m.revision_id = r.id and m.purpose = 'cover')
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  where i.tenant_id = p_tenant_id
    and i.kind::text = any(p_kinds)
    and r.state = 'sealed'
    and r.location operator(extensions.&&)
        extensions.st_makeenvelope(p_west, p_south, p_east, p_north, 4326)::extensions.geography
    and r.latitude between p_south and p_north
    and r.longitude between p_west and p_east
    and (
      i.kind = 'destination'
      or (i.kind = 'event'
          and r.starts_local is not null
          and private.event_ends_at(r.ends_local, r.all_day, t.timezone) > now())
    )
  order by 8 nulls last, 3
  limit p_limit;
end;
$$;

-- The area holding every place on the map (null bounds when there are none).
create function public.portal_map_extent(p_tenant_id uuid)
returns table (
  west double precision,
  south double precision,
  east double precision,
  north double precision,
  destinations integer,
  events integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select min(c.longitude), min(c.latitude), max(c.longitude), max(c.latitude),
         (count(*) filter (where c.kind = 'destination'))::integer,
         (count(*) filter (where c.kind = 'event'))::integer
  from private.portal_map_candidates(p_tenant_id) c;
$$;

revoke all on function public.portal_map_places(uuid, double precision, double precision, double precision, double precision, text[], integer)
  from public, anon, authenticated;
revoke all on function public.portal_map_extent(uuid) from public, anon, authenticated;

grant execute on function public.portal_map_places(uuid, double precision, double precision, double precision, double precision, text[], integer)
  to anon, authenticated;
grant execute on function public.portal_map_extent(uuid) to anon, authenticated;
