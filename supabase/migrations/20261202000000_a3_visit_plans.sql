-- A · Paso 3 — Planes por tipo de visita (ADR-072). Expand only.
--
-- Two facts of a destination or an event that the plans use: how long a visit takes
-- (destinations, 15 to 240 minutes) and whether it suits a visit with children (true,
-- false or not said). They are part of the revision: published with it, restored with
-- «Volver a esta versión». The editor's document has them only when they have a value,
-- so the panel already deployed keeps working during the deploy.

-- ── 1. The columns ───────────────────────────────────────────────────────────

alter table public.content_revisions
  add column visit_minutes smallint,
  add column kids_suitable boolean,
  add constraint content_revisions_visit_minutes_check
    check (visit_minutes is null or (visit_minutes between 15 and 240 and visit_minutes % 5 = 0));

comment on column public.content_revisions.visit_minutes is
  'How long a visit to a destination takes, in minutes (ADR-072); null: 45 in the plans.';
comment on column public.content_revisions.kids_suitable is
  'Whether a destination or an event suits a visit with children (ADR-072): true, false or null (not said).';

-- ── 2. The drafts accept them ───────────────────────────────────────────────

create or replace function private.is_valid_destination_draft(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_image jsonb;
begin
  if not (
    private.has_exact_keys(p, array['title', 'summary', 'body', 'location', 'cover', 'gallery'], array['hours', 'categoryId', 'visitMinutes', 'kids'])
    and private.is_plain_line(p -> 'title', 1, 120)
    and private.is_plain_line(p -> 'summary', 0, 300)
    and private.is_valid_rich_text(p -> 'body')
  ) then
    return false;
  end if;

  if p ? 'hours' and jsonb_typeof(p -> 'hours') <> 'null'
     and not private.is_valid_opening_hours(p -> 'hours') then
    return false;
  end if;

  if p ? 'categoryId' and jsonb_typeof(p -> 'categoryId') <> 'null' and not (
    jsonb_typeof(p -> 'categoryId') = 'string'
    and (p ->> 'categoryId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    return false;
  end if;

  -- How long a visit takes (ADR-072): whole minutes, 15 to 240, in steps of 5.
  if p ? 'visitMinutes' and jsonb_typeof(p -> 'visitMinutes') <> 'null' and not (
    jsonb_typeof(p -> 'visitMinutes') = 'number'
    and (p ->> 'visitMinutes') ~ '^[0-9]{1,3}$'
    and (p ->> 'visitMinutes')::integer between 15 and 240
    and (p ->> 'visitMinutes')::integer % 5 = 0
  ) then
    return false;
  end if;

  -- For a visit with children (ADR-072): true (suitable), false (not recommended) or null.
  if p ? 'kids' and jsonb_typeof(p -> 'kids') not in ('null', 'boolean') then
    return false;
  end if;

  if jsonb_typeof(p -> 'location') <> 'null' and not (
    private.has_exact_keys(p -> 'location', array['lat', 'lng'])
    and jsonb_typeof(p #> '{location,lat}') = 'number'
    and jsonb_typeof(p #> '{location,lng}') = 'number'
    and (p #>> '{location,lat}')::double precision between -90 and 90
    and (p #>> '{location,lng}')::double precision between -180 and 180
  ) then
    return false;
  end if;

  if jsonb_typeof(p -> 'cover') <> 'null' and not private.is_valid_image_reference(p -> 'cover') then
    return false;
  end if;

  if jsonb_typeof(p -> 'gallery') <> 'array' or jsonb_array_length(p -> 'gallery') > 30 then
    return false;
  end if;
  for v_image in select value from jsonb_array_elements(p -> 'gallery') loop
    if not private.is_valid_image_reference(v_image) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function private.is_valid_event_draft(p jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    private.has_exact_keys(p, array['title', 'summary', 'body', 'schedule', 'venueId', 'location', 'cover', 'gallery'], array['categoryId', 'kids'])
    and private.is_valid_destination_draft(p - 'schedule' - 'venueId')
    and (jsonb_typeof(p -> 'schedule') = 'null'
         or exists (select 1 from private.parse_event_schedule(p -> 'schedule')))
    and (jsonb_typeof(p -> 'venueId') = 'null'
         or (jsonb_typeof(p -> 'venueId') = 'string'
             and (p ->> 'venueId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
    false
  );
$$;

-- ── 3. The draft as the editor knows it ─────────────────────────────────────

create or replace function private.revision_document(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when i.kind = 'event' then base.doc || jsonb_build_object(
      'schedule', private.event_schedule_json(r.starts_local, r.ends_local, r.all_day),
      'venueId', r.venue_content_id) || category.doc || traits.doc
    when i.kind = 'knowledge' then jsonb_build_object(
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      'document', coalesce((
        select jsonb_build_object('assetId', v.asset_id, 'version', v.version)
        from public.asset_versions v
        where v.tenant_id = r.tenant_id and v.id = r.document_version_id
      ), 'null'::jsonb))
    when i.kind = 'notice' then jsonb_build_object(
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      'validity', jsonb_build_object(
        'from', to_char(r.notice_from_local, 'YYYY-MM-DD"T"HH24:MI'),
        'until', to_char(r.notice_until_local, 'YYYY-MM-DD"T"HH24:MI')),
      'placeId', r.notice_place_id)
    when i.kind = 'service' then jsonb_build_object(
      'title', r.title,
      'summary', r.summary,
      -- A service created and never saved has only its name: «Otro» until it is chosen.
      'category', coalesce(r.service_category, 'other'),
      'hours', coalesce(r.opening_hours, 'null'::jsonb),
      'phone', r.contact_phone,
      'whatsapp', r.contact_whatsapp,
      'address', coalesce(r.address_line, ''),
      'location', case when r.latitude is null then 'null'::jsonb
                       else jsonb_build_object('lat', r.latitude, 'lng', r.longitude) end)
    when i.kind = 'story' then jsonb_build_object(
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      -- An anonymous story keeps no name (ADR-069).
      'author', coalesce(r.story_author, ''),
      'anonymous', coalesce(r.story_anonymous, false),
      'community', coalesce(r.story_community, ''),
      'placeId', r.story_place_id,
      'consent', coalesce(r.story_consent, false))
    -- A destination: `hours` and `categoryId` only when it has them.
    when r.opening_hours is not null then base.doc || jsonb_build_object('hours', r.opening_hours) || category.doc || traits.doc
    else base.doc || category.doc || traits.doc end
  from public.content_revisions r
  join public.content_items i on i.id = r.content_id
  cross join lateral (
    select case when r.category_id is null then '{}'::jsonb
                else jsonb_build_object('categoryId', r.category_id) end as doc
  ) category
  -- The visit time and «for children» (ADR-072), only when they have a value.
  cross join lateral (
    select jsonb_strip_nulls(jsonb_build_object(
      'visitMinutes', case when i.kind = 'destination' then r.visit_minutes end,
      'kids', r.kids_suitable)) as doc
  ) traits
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

-- ── 4. Saving ────────────────────────────────────────────────────────────────

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
  v_document uuid;
  v_hours jsonb;
  v_category uuid;
  v_notice_from timestamp;
  v_notice_until timestamp;
  v_place uuid;
  v_service_category text;
  v_phone text;
  v_whatsapp text;
  v_address text;
  v_story_author text;
  v_story_anonymous boolean;
  v_story_community text;
  v_story_place uuid;
  v_story_consent boolean;
  v_visit_minutes smallint;
  v_kids boolean;
  v_valid boolean;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;

  v_valid := case v_item.kind
    when 'event' then private.is_valid_event_draft(p_document)
    when 'knowledge' then private.is_valid_knowledge_draft(p_document)
    when 'notice' then private.is_valid_notice_draft(p_document)
    when 'service' then private.is_valid_service_draft(p_document)
    when 'story' then private.is_valid_story_draft(p_document)
    when 'destination' then private.is_valid_destination_draft(p_document)
    else false
  end;
  if p_document is null or not coalesce(v_valid, false) then
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
  elsif v_item.kind = 'knowledge' then
    v_document := private.knowledge_document_version(p_tenant_id, p_document -> 'document');
  elsif v_item.kind = 'notice' then
    select f.from_local, f.until_local into v_notice_from, v_notice_until
    from private.parse_notice_validity(p_document -> 'validity') f;
    -- The place: a destination or an event of this municipality (ADR-069).
    if jsonb_typeof(p_document -> 'placeId') = 'string' then
      v_place := (p_document ->> 'placeId')::uuid;
      if not exists (
        select 1 from public.content_items d
        where d.tenant_id = p_tenant_id and d.id = v_place and d.kind in ('destination', 'event')
      ) then
        raise exception 'the place is not a destination or an event of this tenant'
          using errcode = '23514', hint = 'place';
      end if;
    end if;
  elsif v_item.kind = 'service' then
    -- A category of the platform's list, the opening hours of destinations (ADR-039), how to
    -- reach it and where it is (ADR-069).
    v_service_category := p_document ->> 'category';
    if jsonb_typeof(p_document -> 'hours') = 'object' then
      v_hours := p_document -> 'hours';
    end if;
    v_phone := nullif(p_document ->> 'phone', '');
    v_whatsapp := nullif(p_document ->> 'whatsapp', '');
    v_address := nullif(p_document ->> 'address', '');
  elsif v_item.kind = 'story' then
    -- Who tells it (or «anónimo», without keeping the name), their community, the destination it
    -- is about and whether the person agreed to publish it (ADR-069).
    v_story_anonymous := (p_document ->> 'anonymous')::boolean;
    v_story_author := case when v_story_anonymous then null else nullif(p_document ->> 'author', '') end;
    v_story_community := nullif(p_document ->> 'community', '');
    v_story_consent := (p_document ->> 'consent')::boolean;
    if jsonb_typeof(p_document -> 'placeId') = 'string' then
      v_story_place := (p_document ->> 'placeId')::uuid;
      if not exists (
        select 1 from public.content_items d
        where d.tenant_id = p_tenant_id and d.id = v_story_place and d.kind = 'destination'
      ) then
        raise exception 'the place is not a destination of this tenant'
          using errcode = '23514', hint = 'place';
      end if;
    end if;
  elsif jsonb_typeof(p_document -> 'hours') = 'object' then
    v_hours := p_document -> 'hours';
  end if;

  -- A category of this municipality, of the item's kind, still in use (ADR-062).
  if jsonb_typeof(p_document -> 'categoryId') = 'string' then
    v_category := (p_document ->> 'categoryId')::uuid;
    if not exists (
      select 1 from public.content_categories c
      where c.tenant_id = p_tenant_id and c.id = v_category
        and c.kind = v_item.kind and c.archived_at is null
    ) then
      raise exception 'not a category of this tenant for this kind of content'
        using errcode = '23514', hint = 'category';
    end if;
  end if;

  -- The visit time (destinations) and «for children» (destinations and events), ADR-072.
  if v_item.kind = 'destination' and jsonb_typeof(p_document -> 'visitMinutes') = 'number' then
    v_visit_minutes := (p_document ->> 'visitMinutes')::smallint;
  end if;
  if v_item.kind in ('destination', 'event') and jsonb_typeof(p_document -> 'kids') = 'boolean' then
    v_kids := (p_document ->> 'kids')::boolean;
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
      body = coalesce(p_document -> 'body', '[]'::jsonb),
      latitude = (p_document #>> '{location,lat}')::double precision,
      longitude = (p_document #>> '{location,lng}')::double precision,
      starts_local = v_starts,
      ends_local = v_ends,
      all_day = v_all_day,
      venue_content_id = v_venue,
      document_version_id = v_document,
      opening_hours = v_hours,
      category_id = v_category,
      notice_from_local = v_notice_from,
      notice_until_local = v_notice_until,
      notice_place_id = v_place,
      service_category = v_service_category,
      contact_phone = v_phone,
      contact_whatsapp = v_whatsapp,
      address_line = v_address,
      story_author = v_story_author,
      story_anonymous = v_story_anonymous,
      story_community = v_story_community,
      story_place_id = v_story_place,
      story_consent = v_story_consent,
      visit_minutes = v_visit_minutes,
      kids_suitable = v_kids,
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
  if jsonb_typeof(p_document -> 'gallery') = 'array' then
    for v_image in select value from jsonb_array_elements(p_document -> 'gallery') loop
      insert into public.media_references (tenant_id, revision_id, asset_version_id, purpose, position, alt_text)
      values (p_tenant_id, v_draft.id,
              private.content_image_version(p_tenant_id, v_image, false),
              'gallery', v_position, v_image ->> 'alt');
      v_position := v_position + 1;
    end loop;
  end if;

  update public.content_items i set updated_at = now() where i.id = p_content_id;

  return query select v_draft.id, v_draft.revision_no, v_draft.edit_count;
end;
$$;

-- ── 5. The indexer says them in words («¿se puede ir con niños?») ────────────

create or replace function worker_api.knowledge_source(p_job_id uuid, p_fencing_token bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_result jsonb;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'knowledge.index' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;

  if v_job.subject_type = 'content_revision' then
    select jsonb_build_object(
      'status', 'ok',
      'source', 'content',
      'kind', i.kind,
      'slug', i.slug,
      'revisionNo', r.revision_no,
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      'timezone', t.timezone,
      'schedule', case when i.kind = 'event'
                    then private.event_schedule_json(r.starts_local, r.ends_local, r.all_day) end,
      'hours', r.opening_hours,
      'visitMinutes', case when i.kind = 'destination' then r.visit_minutes end,
      'kids', case when i.kind in ('destination', 'event') then r.kids_suitable end,
      'venueTitle', (
        select vr.title from public.content_items vi
        join public.content_revisions vr on vr.id = vi.published_revision_id
        where vi.tenant_id = r.tenant_id and vi.id = r.venue_content_id
      ),
      'validity', case when i.kind = 'notice' then jsonb_build_object(
                    'from', to_char(r.notice_from_local, 'YYYY-MM-DD"T"HH24:MI'),
                    'until', to_char(r.notice_until_local, 'YYYY-MM-DD"T"HH24:MI')) end,
      'service', case when i.kind = 'service' then jsonb_build_object(
                   'category', r.service_category,
                   'phone', r.contact_phone,
                   'whatsapp', r.contact_whatsapp,
                   'address', r.address_line) end,
      'story', case when i.kind = 'story' then jsonb_build_object(
                 'author', r.story_author,
                 'anonymous', coalesce(r.story_anonymous, false),
                 'community', r.story_community) end,
      'placeTitle', (
        select pr.title from public.content_items pi
        join public.content_revisions pr on pr.id = pi.published_revision_id
        where pi.tenant_id = r.tenant_id and pi.id = coalesce(r.notice_place_id, r.story_place_id)
      ),
      'document', (
        select jsonb_build_object(
          'prefix', v.tenant_id::text || '/' || v.asset_id::text || '/' || v.version::text || '/',
          'manifest', v.manifest)
        from public.asset_versions v
        where v.tenant_id = r.tenant_id and v.id = r.document_version_id and v.status = 'ready'
      )
    ) into v_result
    from public.content_revisions r
    join public.content_items i on i.tenant_id = r.tenant_id and i.id = r.content_id
    join public.tenants t on t.id = r.tenant_id
    where r.tenant_id = v_job.tenant_id and r.id = v_job.subject_id and r.state = 'sealed';
  elsif v_job.subject_type = 'tour_revision' then
    select jsonb_build_object(
      'status', 'ok',
      'source', 'tour',
      'kind', i.kind,
      'slug', i.slug,
      'revisionNo', r.revision_no,
      'title', coalesce(cr.title, i.slug),
      'manifest', r.manifest
    ) into v_result
    from public.tour_revisions r
    join public.tours tr on tr.tenant_id = r.tenant_id and tr.id = r.tour_id
    join public.content_items i on i.tenant_id = tr.tenant_id and i.id = tr.content_id
    left join public.content_revisions cr on cr.id = i.published_revision_id
    where r.tenant_id = v_job.tenant_id and r.id = v_job.subject_id and r.state = 'sealed';
  end if;

  return coalesce(v_result, jsonb_build_object('status', 'not_found'));
end;
$$;

-- ── 6. What a plan of the visitor's assistant reads ────────────────────────────

-- For each published destination and event of an active municipality with one of the two
-- facts: its visit time and whether it suits children. Public data, like the hours.
create function public.portal_plan_traits(p_tenant_id uuid)
returns table (kind text, slug text, visit_minutes integer, kids boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select i.kind::text, i.slug,
         case when i.kind = 'destination' then r.visit_minutes::integer end,
         r.kids_suitable
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  where i.tenant_id = p_tenant_id
    and i.kind in ('destination', 'event')
    and r.state = 'sealed'
    and (r.visit_minutes is not null or r.kids_suitable is not null)
  order by i.kind, i.slug;
$$;
revoke all on function public.portal_plan_traits(uuid) from public, anon, authenticated;
grant execute on function public.portal_plan_traits(uuid) to anon, authenticated;
