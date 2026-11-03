-- P5 · Paso 4 — opening hours of destinations (ADR-039). Expand only.
--
--   * A destination's document accepts an optional `hours`:
--       {"mode": "always", "note": ""}
--       {"mode": "weekly", "days": [7 × [up to 2 × ["HH:MM", "HH:MM"]]], "note": ""}
--     Days start on Monday; a range opens before it closes, within the day ("24:00" closes
--     at midnight); a second range starts after the first one closes; at least one range.
--     The hours are the municipality's local time (tenants.timezone).
--   * Stored on the revision (content_revisions.opening_hours): sealed with it, restored
--     with it. A revision without hours keeps NULL; `revision_document` adds the key only
--     when there are hours, so a document without them looks exactly as before.
--   * portal_opening_hours: the hours of every published destination of an active tenant
--     (anonymous, like the other portal reads). The portal's pages and the assistant's
--     plans (`qué hay cerca`, `plan para hoy`, `ruta sugerida`) read them here.
--   * The indexer reads them (worker_api.knowledge_source) so the assistant can answer «¿a
--     qué hora abre…?» from the published text.

-- ── Validation ─────────────────────────────────────────────────────────────

create function private.is_valid_opening_hours(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_day jsonb;
  v_range jsonb;
  v_open text;
  v_close text;
  v_previous text;
  v_ranges integer := 0;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if not private.is_plain_line(p -> 'note', 0, 120) then
    return false;
  end if;

  if p ->> 'mode' = 'always' then
    return private.has_exact_keys(p, array['mode', 'note']);
  end if;
  if p ->> 'mode' <> 'weekly'
     or not private.has_exact_keys(p, array['mode', 'days', 'note'])
     or jsonb_typeof(p -> 'days') <> 'array'
     or jsonb_array_length(p -> 'days') <> 7 then
    return false;
  end if;

  for v_day in select value from jsonb_array_elements(p -> 'days') loop
    if jsonb_typeof(v_day) <> 'array' or jsonb_array_length(v_day) > 2 then
      return false;
    end if;
    v_previous := null;
    for v_range in select value from jsonb_array_elements(v_day) loop
      if jsonb_typeof(v_range) <> 'array' or jsonb_array_length(v_range) <> 2
         or jsonb_typeof(v_range -> 0) <> 'string' or jsonb_typeof(v_range -> 1) <> 'string' then
        return false;
      end if;
      v_open := v_range ->> 0;
      v_close := v_range ->> 1;
      if v_open !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or v_close !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
         or v_open >= v_close
         or (v_previous is not null and v_open <= v_previous) then
        return false;
      end if;
      v_previous := v_close;
      v_ranges := v_ranges + 1;
    end loop;
  end loop;
  return v_ranges > 0;
end;
$$;

revoke all on function private.is_valid_opening_hours(jsonb) from public;

alter table public.content_revisions add column opening_hours jsonb;
alter table public.content_revisions
  add constraint content_revisions_opening_hours check (
    opening_hours is null or private.is_valid_opening_hours(opening_hours)
  );

-- The destination's draft: the same keys as before, and `hours` (optional, null or valid).
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
    private.has_exact_keys(p, array['title', 'summary', 'body', 'location', 'cover', 'gallery'], array['hours'])
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

-- ── Reading and saving ─────────────────────────────────────────────────────

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
      'venueId', r.venue_content_id)
    when i.kind = 'knowledge' then jsonb_build_object(
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      'document', coalesce((
        select jsonb_build_object('assetId', v.asset_id, 'version', v.version)
        from public.asset_versions v
        where v.tenant_id = r.tenant_id and v.id = r.document_version_id
      ), 'null'::jsonb))
    -- A destination: `hours` only when it has them (the document is unchanged otherwise).
    when r.opening_hours is not null then base.doc || jsonb_build_object('hours', r.opening_hours)
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
    else private.is_valid_destination_draft(p_document)
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
  elsif jsonb_typeof(p_document -> 'hours') = 'object' then
    v_hours := p_document -> 'hours';
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
      document_version_id = v_document,
      opening_hours = v_hours,
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

-- ── Portal ─────────────────────────────────────────────────────────────────

-- The hours of the published destinations that have them (anonymous; active tenants only).
create function public.portal_opening_hours(p_tenant_id uuid)
returns table (slug text, hours jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select i.slug, r.opening_hours
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  where i.tenant_id = p_tenant_id
    and i.kind = 'destination'
    and r.state = 'sealed'
    and r.opening_hours is not null
  order by i.slug;
$$;

revoke all on function public.portal_opening_hours(uuid) from public, anon, authenticated;
grant execute on function public.portal_opening_hours(uuid) to anon, authenticated;

-- ── Indexer ────────────────────────────────────────────────────────────────

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
      'venueTitle', (
        select vr.title from public.content_items vi
        join public.content_revisions vr on vr.id = vi.published_revision_id
        where vi.tenant_id = r.tenant_id and vi.id = r.venue_content_id
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
