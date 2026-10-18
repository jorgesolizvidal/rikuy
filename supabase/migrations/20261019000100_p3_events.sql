-- ─────────────────────────────────────────────────────────────────────────────
-- P3 · Paso 4: events (one occurrence) and the agenda.
--
--   * An event is a content item of kind 'event' with the same revision model as
--     destinations (draft → sealed → rollback) plus a schedule and an optional venue.
--   * The schedule is stored as LOCAL wall-clock time of the municipality (what the
--     organizer writes: "2 Nov, 19:00") and becomes an instant with the tenant's time
--     zone when it is read. All-day events store dates; their end day is inclusive.
--   * Public reads list only events that have not ended yet — nobody has to unpublish
--     them. An ended event keeps its page (shared links keep working) marked as ended.
--   * The venue is an optional destination of the same tenant; the event keeps its own
--     coordinates (copied from the venue in the editor), so it never depends on it.
-- Expand-only: new nullable columns, new functions; existing RPCs are replaced with
-- versions that behave the same for destinations.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tenant time zones must be real (events depend on them) ─────────────────

create function private.assert_valid_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  begin
    perform now() at time zone new.timezone;
  exception when others then
    raise exception 'unknown time zone' using errcode = '23514', hint = 'timezone';
  end;
  return new;
end;
$$;

revoke all on function private.assert_valid_timezone() from public;

create trigger tenants_valid_timezone
  before insert or update of timezone on public.tenants
  for each row execute function private.assert_valid_timezone();

-- ── Schedule and venue on revisions ────────────────────────────────────────

alter table public.content_revisions
  add column starts_local     timestamp,
  add column ends_local       timestamp,
  add column all_day          boolean,
  add column venue_content_id uuid,
  add constraint content_revisions_schedule check (
    (starts_local is null) = (ends_local is null)
    and (starts_local is null) = (all_day is null)
    and (starts_local is null or ends_local >= starts_local)
    and (all_day is not true
         or (starts_local = date_trunc('day', starts_local) and ends_local = date_trunc('day', ends_local)))
  ),
  add constraint content_revisions_venue_fkey foreign key (tenant_id, venue_content_id)
    references public.content_items (tenant_id, id) on delete restrict;

create index content_revisions_venue_idx on public.content_revisions (tenant_id, venue_content_id)
  where venue_content_id is not null;

-- ── Validation (mirror of @rikuy/core eventDocument) ───────────────────────

-- {allDay, start, end} → local bounds, or no row when invalid. Dates must exist
-- (no 30 February, no 24:00), the end is not before the start, at most a year long.
create function private.parse_event_schedule(p jsonb)
returns table (starts_local timestamp, ends_local timestamp, all_day boolean)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_all_day boolean;
  v_pattern text;
  v_format text;
  v_start timestamp;
  v_end timestamp;
begin
  if p is null or jsonb_typeof(p) <> 'object'
     or not private.has_exact_keys(p, array['allDay', 'start', 'end'])
     or jsonb_typeof(p -> 'allDay') <> 'boolean'
     or jsonb_typeof(p -> 'start') <> 'string'
     or jsonb_typeof(p -> 'end') <> 'string' then
    return;
  end if;
  v_all_day := (p ->> 'allDay')::boolean;
  -- (A CASE inside an IF condition would end at its first THEN, hence the variable.)
  v_pattern := '^\d{4}-\d{2}-\d{2}$';
  if not v_all_day then
    v_pattern := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$';
  end if;
  if (p ->> 'start') !~ v_pattern or (p ->> 'end') !~ v_pattern then
    return;
  end if;
  begin
    v_start := (p ->> 'start')::timestamp;
    v_end := (p ->> 'end')::timestamp;
  exception when others then
    return;
  end;
  v_format := 'YYYY-MM-DD';
  if not v_all_day then
    v_format := 'YYYY-MM-DD"T"HH24:MI';
  end if;
  -- Postgres normalizes some inputs (e.g. 24:00); only exact round trips are accepted.
  if to_char(v_start, v_format) <> (p ->> 'start') or to_char(v_end, v_format) <> (p ->> 'end')
     or v_end < v_start
     or v_end - v_start > interval '366 days'
     or extract(year from v_start) not between 2000 and 2100 then
    return;
  end if;
  return query select v_start, v_end, v_all_day;
end;
$$;

-- Event draft: the destination fields plus {schedule|null, venueId|null}.
create function private.is_valid_event_draft(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    private.has_exact_keys(p, array['title', 'summary', 'body', 'schedule', 'venueId', 'location', 'cover', 'gallery'])
    and private.is_valid_destination_draft(p - 'schedule' - 'venueId')
    and (jsonb_typeof(p -> 'schedule') = 'null'
         or exists (select 1 from private.parse_event_schedule(p -> 'schedule')))
    and (jsonb_typeof(p -> 'venueId') = 'null'
         or (jsonb_typeof(p -> 'venueId') = 'string'
             and (p ->> 'venueId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
    false
  );
$$;

-- The stored schedule as the editor writes it.
create function private.event_schedule_json(p_start timestamp, p_end timestamp, p_all_day boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p_start is null then null else jsonb_build_object(
    'allDay', p_all_day,
    'start', to_char(p_start, case when p_all_day then 'YYYY-MM-DD' else 'YYYY-MM-DD"T"HH24:MI' end),
    'end', to_char(p_end, case when p_all_day then 'YYYY-MM-DD' else 'YYYY-MM-DD"T"HH24:MI' end)
  ) end;
$$;

-- Local wall-clock bounds → instants in the tenant's time zone (all-day: end of last day).
create function private.event_starts_at(p_start timestamp, p_timezone text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select p_start at time zone p_timezone;
$$;

create function private.event_ends_at(p_end timestamp, p_all_day boolean, p_timezone text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select (case when p_all_day then p_end + interval '1 day' else p_end end) at time zone p_timezone;
$$;

revoke all on function private.parse_event_schedule(jsonb) from public;
revoke all on function private.is_valid_event_draft(jsonb) from public;
revoke all on function private.event_schedule_json(timestamp, timestamp, boolean) from public;
revoke all on function private.event_starts_at(timestamp, text) from public;
revoke all on function private.event_ends_at(timestamp, boolean, text) from public;

-- ── Documents: events carry their schedule and venue ───────────────────────

create or replace function private.revision_document(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when i.kind = 'event' then base.doc || jsonb_build_object(
           'schedule', private.event_schedule_json(r.starts_local, r.ends_local, r.all_day),
           'venueId', r.venue_content_id)
         else base.doc end
  from public.content_revisions r
  join public.content_items i on i.id = r.content_id
  cross join lateral (
    select jsonb_build_object(
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      'location', case when r.latitude is null then 'null'::jsonb
                       else jsonb_build_object('lat', r.latitude, 'lng', r.longitude) end,
      'cover', coalesce((
        select jsonb_build_object('assetId', v.asset_id, 'version', v.version, 'alt', m.alt_text)
        from public.media_references m
        join public.asset_versions v on v.tenant_id = m.tenant_id and v.id = m.asset_version_id
        where m.revision_id = r.id and m.purpose = 'cover'
      ), 'null'::jsonb),
      'gallery', coalesce((
        select jsonb_agg(jsonb_build_object('assetId', v.asset_id, 'version', v.version, 'alt', m.alt_text)
                         order by m.position)
        from public.media_references m
        join public.asset_versions v on v.tenant_id = m.tenant_id and v.id = m.asset_version_id
        where m.revision_id = r.id and m.purpose = 'gallery'
      ), '[]'::jsonb)
    ) as doc
  ) base
  where r.id = p_revision_id;
$$;

-- ── Intent RPCs, now kind-aware ────────────────────────────────────────────

create or replace function public.save_content_draft(
  p_tenant_id uuid,
  p_content_id uuid,
  p_document jsonb,
  p_expected_edit integer
)
returns table (revision_id uuid, revision_no integer, edit_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item public.content_items%rowtype;
  v_draft public.content_revisions%rowtype;
  v_image jsonb;
  v_position integer := 0;
  v_starts timestamp;
  v_ends timestamp;
  v_all_day boolean;
  v_venue uuid;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;

  if p_document is null
     or (v_item.kind = 'event' and not private.is_valid_event_draft(p_document))
     or (v_item.kind <> 'event' and not private.is_valid_destination_draft(p_document)) then
    raise exception 'invalid content document' using errcode = '23514';
  end if;

  if v_item.kind = 'event' then
    select s.starts_local, s.ends_local, s.all_day into v_starts, v_ends, v_all_day
    from private.parse_event_schedule(p_document -> 'schedule') s;
    if jsonb_typeof(p_document -> 'venueId') = 'string' then
      v_venue := (p_document ->> 'venueId')::uuid;
      if not exists (
        select 1 from public.content_items d
        where d.tenant_id = p_tenant_id and d.id = v_venue and d.kind = 'destination'
      ) then
        raise exception 'the venue is not a destination of this tenant' using errcode = '23514', hint = 'venue';
      end if;
    end if;
  end if;

  if v_item.draft_revision_id is null then
    if p_expected_edit is not null then
      raise exception 'the draft was published or discarded meanwhile' using errcode = 'PT409';
    end if;
    insert into public.content_revisions (tenant_id, content_id, revision_no, title, created_by, updated_by)
    values (
      p_tenant_id, p_content_id,
      (select max(r.revision_no) + 1 from public.content_revisions r where r.content_id = p_content_id),
      p_document ->> 'title', (select auth.uid()), (select auth.uid())
    )
    returning * into v_draft;
    update public.content_items i set draft_revision_id = v_draft.id, updated_at = now()
    where i.id = p_content_id;
  else
    select r.* into v_draft from public.content_revisions r where r.id = v_item.draft_revision_id for update;
    if p_expected_edit is distinct from v_draft.edit_count then
      raise exception 'the draft changed meanwhile' using errcode = 'PT409';
    end if;
  end if;

  update public.content_revisions r
  set title = p_document ->> 'title',
      summary = p_document ->> 'summary',
      body = p_document -> 'body',
      latitude = (p_document #>> '{location,lat}')::double precision,
      longitude = (p_document #>> '{location,lng}')::double precision,
      starts_local = v_starts,
      ends_local = v_ends,
      all_day = v_all_day,
      venue_content_id = v_venue,
      edit_count = case when v_item.draft_revision_id is null then r.edit_count else r.edit_count + 1 end,
      updated_by = (select auth.uid()),
      updated_at = now()
  where r.id = v_draft.id
  returning * into v_draft;

  delete from public.media_references m where m.revision_id = v_draft.id;
  if jsonb_typeof(p_document -> 'cover') = 'object' then
    insert into public.media_references (tenant_id, revision_id, asset_version_id, purpose, position, alt_text)
    values (p_tenant_id, v_draft.id,
            private.content_image_version(p_tenant_id, p_document -> 'cover', false),
            'cover', 0, p_document #>> '{cover,alt}');
  end if;
  for v_image in select value from jsonb_array_elements(p_document -> 'gallery') loop
    insert into public.media_references (tenant_id, revision_id, asset_version_id, purpose, position, alt_text)
    values (p_tenant_id, v_draft.id,
            private.content_image_version(p_tenant_id, v_image, false),
            'gallery', v_position, v_image ->> 'alt');
    v_position := v_position + 1;
  end loop;

  update public.content_items i set updated_at = now() where i.id = p_content_id;

  return query select v_draft.id, v_draft.revision_no, v_draft.edit_count;
end;
$$;

create or replace function public.publish_content(
  p_tenant_id uuid,
  p_content_id uuid,
  p_expected_edit integer
)
returns table (revision_id uuid, revision_no integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item public.content_items%rowtype;
  v_draft public.content_revisions%rowtype;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;
  if v_item.draft_revision_id is null then
    raise exception 'there is no draft to publish' using errcode = 'PT409';
  end if;

  select r.* into v_draft from public.content_revisions r where r.id = v_item.draft_revision_id for update;
  if v_draft.edit_count is distinct from p_expected_edit then
    raise exception 'the draft changed meanwhile' using errcode = 'PT409';
  end if;

  -- Visitors need a summary and a location; events also need their date.
  if v_draft.summary = '' or v_draft.latitude is null
     or (v_item.kind = 'event' and v_draft.starts_local is null) then
    raise exception 'the content is missing what visitors need to see it'
      using errcode = '23514', hint = 'incomplete';
  end if;
  -- Its images' public derivatives must exist before the portal can point at them.
  if exists (
    select 1
    from public.media_references m
    join public.asset_versions v on v.tenant_id = m.tenant_id and v.id = m.asset_version_id
    where m.revision_id = v_draft.id and (v.status <> 'ready' or v.published_at is null)
  ) then
    raise exception 'an image is not published yet' using errcode = 'PT409', hint = 'media';
  end if;

  update public.content_revisions r
  set state = 'sealed', sealed_at = now(), sealed_by = (select auth.uid())
  where r.id = v_draft.id;

  update public.content_items i
  set published_revision_id = v_draft.id, draft_revision_id = null, published_at = now(), updated_at = now()
  where i.id = p_content_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'content.published', 'content_item', p_content_id,
          v_draft.revision_no, 'success',
          jsonb_build_object('kind', v_item.kind, 'revision_id', v_draft.id,
                             'previous_revision_id', v_item.published_revision_id));

  return query select v_draft.id, v_draft.revision_no;
end;
$$;

-- ── Members: the agenda in the panel ───────────────────────────────────────

-- Every event of the tenant with the schedule editors are working on (open draft, else
-- published) and whether it already ended in the tenant's time zone.
create function public.list_content_events(p_tenant_id uuid)
returns table (
  content_id uuid,
  slug text,
  title text,
  has_draft boolean,
  is_published boolean,
  schedule jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  ended boolean,
  updated_at timestamptz,
  published_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  return query
  select i.id, i.slug, r.title,
         i.draft_revision_id is not null, i.published_revision_id is not null,
         private.event_schedule_json(r.starts_local, r.ends_local, r.all_day),
         private.event_starts_at(r.starts_local, t.timezone),
         private.event_ends_at(r.ends_local, r.all_day, t.timezone),
         coalesce(private.event_ends_at(r.ends_local, r.all_day, t.timezone) <= now(), false),
         i.updated_at, i.published_at
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id
  join public.content_revisions r on r.id = coalesce(i.draft_revision_id, i.published_revision_id)
  where i.tenant_id = p_tenant_id and i.kind = 'event'
  order by r.starts_local nulls first, r.title;
end;
$$;

-- ── Anonymous reads for portals ────────────────────────────────────────────

-- The venue shown on the event page: a PUBLISHED destination of the same tenant.
create function private.public_venue(p_tenant_id uuid, p_venue uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('slug', d.slug, 'title', dr.title)
  from public.content_items d
  join public.content_revisions dr on dr.id = d.published_revision_id and dr.content_id = d.id
  where d.tenant_id = p_tenant_id and d.id = p_venue and d.kind = 'destination' and dr.state = 'sealed';
$$;

revoke all on function private.public_venue(uuid, uuid) from public;

-- Events that have not ended yet, soonest first.
create function public.portal_events(p_tenant_id uuid)
returns table (
  slug text,
  title text,
  summary text,
  schedule jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  latitude double precision,
  longitude double precision,
  cover jsonb,
  venue jsonb,
  published_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.slug, r.title, r.summary,
         private.event_schedule_json(r.starts_local, r.ends_local, r.all_day),
         private.event_starts_at(r.starts_local, t.timezone),
         private.event_ends_at(r.ends_local, r.all_day, t.timezone),
         r.latitude, r.longitude,
         (select private.public_image(m.asset_version_id, m.alt_text)
          from public.media_references m
          where m.revision_id = r.id and m.purpose = 'cover'),
         private.public_venue(i.tenant_id, r.venue_content_id),
         i.published_at, r.sealed_at
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  where i.tenant_id = p_tenant_id
    and i.kind = 'event'
    and r.state = 'sealed'
    and r.starts_local is not null
    and private.event_ends_at(r.ends_local, r.all_day, t.timezone) > now()
  order by r.starts_local, r.title;
$$;

-- One published event (also after it ended: its page says so).
create function public.portal_event(p_tenant_id uuid, p_slug text)
returns table (
  slug text,
  revision_no integer,
  title text,
  summary text,
  body jsonb,
  schedule jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  ended boolean,
  latitude double precision,
  longitude double precision,
  cover jsonb,
  gallery jsonb,
  venue jsonb,
  published_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.slug, r.revision_no, r.title, r.summary, r.body,
         private.event_schedule_json(r.starts_local, r.ends_local, r.all_day),
         private.event_starts_at(r.starts_local, t.timezone),
         private.event_ends_at(r.ends_local, r.all_day, t.timezone),
         private.event_ends_at(r.ends_local, r.all_day, t.timezone) <= now(),
         r.latitude, r.longitude,
         (select private.public_image(m.asset_version_id, m.alt_text)
          from public.media_references m
          where m.revision_id = r.id and m.purpose = 'cover'),
         coalesce((select jsonb_agg(private.public_image(m.asset_version_id, m.alt_text) order by m.position)
                   from public.media_references m
                   where m.revision_id = r.id and m.purpose = 'gallery'), '[]'::jsonb),
         private.public_venue(i.tenant_id, r.venue_content_id),
         i.published_at, r.sealed_at
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  where i.tenant_id = p_tenant_id
    and i.kind = 'event'
    and i.slug = p_slug
    and r.state = 'sealed'
    and r.starts_local is not null;
$$;

revoke all on function public.list_content_events(uuid) from public, anon, authenticated;
revoke all on function public.portal_events(uuid) from public, anon, authenticated;
revoke all on function public.portal_event(uuid, text) from public, anon, authenticated;

grant execute on function public.list_content_events(uuid) to authenticated;
grant execute on function public.portal_events(uuid) to anon, authenticated;
grant execute on function public.portal_event(uuid, text) to anon, authenticated;
