-- A · Paso 1.2 (ADR-069): local services — where to eat, sleep, take out cash, catch
-- transport, fill up the tank — with their opening hours and how to reach them.
--
--   * A service is content of kind 'service', in the module «Servicios locales» (`services`):
--     draft → publish → sealed revisions, «Volver a esta versión», «Retirar» (it closed) and
--     audit, like everything else. Only owners and admins publish it; editors prepare it.
--   * Its category comes from a fixed list of the platform (the names live in the app); it
--     has a short description, the opening hours of destinations (ADR-039), a phone and a
--     WhatsApp number, an address in words and, optionally, its place on the map.
--   * The portal reads them with portal_services (anonymous, active municipalities); the
--     assistant reads its indexed text (category in words, hours and contact).
--
-- Expand only: four nullable columns, a module, new functions, and the functions that branch on
-- the kind of content replaced with one more branch (same signatures, same answers for the kinds
-- that already existed).

-- ── 1. The module ───────────────────────────────────────────────────────────

insert into public.platform_modules (key, position, requires) values ('services', 9, null);

-- Every municipality that exists gets it, like every module (ADR-060, ADR-069).
insert into public.tenant_modules (tenant_id, module)
select t.id, 'services' from public.tenants t
on conflict do nothing;

create or replace function private.content_items_module()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'event' then
    perform private.assert_module(new.tenant_id, 'agenda');
  elsif new.kind = 'knowledge' then
    perform private.assert_module(new.tenant_id, 'assistant');
  elsif new.kind = 'service' then
    perform private.assert_module(new.tenant_id, 'services');
  end if;
  return new;
end;
$$;

-- ── 2. What a service has, on its revisions ─────────────────────────────────

alter table public.content_revisions
  add column service_category text,
  add column contact_phone    text,
  add column contact_whatsapp text,
  add column address_line     text,
  add constraint content_revisions_service_category check (
    service_category is null
    or service_category in ('food', 'lodging', 'cash', 'transport', 'fuel', 'health', 'tourist_info', 'other')
  ),
  add constraint content_revisions_contact_phone check (
    contact_phone is null or contact_phone ~ '^\+?[0-9][0-9 ()-]{5,22}$'
  ),
  add constraint content_revisions_contact_whatsapp check (
    contact_whatsapp is null or contact_whatsapp ~ '^\+[0-9][0-9 ()-]{6,22}$'
  ),
  add constraint content_revisions_address_line check (
    address_line is null or char_length(address_line) between 1 and 160
  );

-- A number as people write it: digits, spaces, parentheses and dashes; WhatsApp needs the
-- country code (+591…) to make a wa.me link.
create function private.is_valid_contact_number(p jsonb, p_international boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'null'
    or (jsonb_typeof(p) = 'string'
        and (p #>> '{}') ~ case when p_international then '^\+[0-9][0-9 ()-]{6,22}$'
                                else '^\+?[0-9][0-9 ()-]{5,22}$' end);
$$;

revoke all on function private.is_valid_contact_number(jsonb, boolean) from public;

-- What the editor saves (mirror of @rikuy/core serviceDocumentSchema).
create function private.is_valid_service_draft(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not (
    jsonb_typeof(p) = 'object'
    and private.has_exact_keys(
      p, array['title', 'summary', 'category', 'hours', 'phone', 'whatsapp', 'address', 'location'])
    and private.is_plain_line(p -> 'title', 1, 120)
    and private.is_plain_line(p -> 'summary', 0, 300)
    and jsonb_typeof(p -> 'category') = 'string'
    and (p ->> 'category') in ('food', 'lodging', 'cash', 'transport', 'fuel', 'health', 'tourist_info', 'other')
    and private.is_valid_contact_number(p -> 'phone', false)
    and private.is_valid_contact_number(p -> 'whatsapp', true)
    and private.is_plain_line(p -> 'address', 0, 160)
  ) then
    return false;
  end if;

  if jsonb_typeof(p -> 'hours') <> 'null' and not private.is_valid_opening_hours(p -> 'hours') then
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
  return true;
end;
$$;

revoke all on function private.is_valid_service_draft(jsonb) from public;

-- ── 3. The draft as the editor knows it: one more branch ──────────────────────

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
      'venueId', r.venue_content_id) || category.doc
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
    -- A destination: `hours` and `categoryId` only when it has them.
    when r.opening_hours is not null then base.doc || jsonb_build_object('hours', r.opening_hours) || category.doc
    else base.doc || category.doc end
  from public.content_revisions r
  join public.content_items i on i.id = r.content_id
  cross join lateral (
    select case when r.category_id is null then '{}'::jsonb
                else jsonb_build_object('categoryId', r.category_id) end as doc
  ) category
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


-- ── 4. Saving: what a service has ───────────────────────────────────────────

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


-- ── 5. Publishing: a service needs a way to find it ─────────────────────────

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
  v_timezone text;
  v_from_at timestamptz;
  v_until_at timestamptz;
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

  if v_item.kind = 'knowledge' then
    -- The assistant needs something to read: its own text or a document.
    if v_draft.body = '[]'::jsonb and v_draft.document_version_id is null then
      raise exception 'the knowledge has no text and no document' using errcode = '23514', hint = 'incomplete';
    end if;
    if v_draft.document_version_id is not null and not exists (
      select 1 from public.asset_versions v
      where v.tenant_id = p_tenant_id and v.id = v_draft.document_version_id and v.status = 'ready'
    ) then
      raise exception 'the document is not read yet' using errcode = 'PT409', hint = 'document';
    end if;
  elsif v_item.kind = 'notice' then
    -- The text the strip shows, and an end (ADR-069).
    if v_draft.summary = '' or v_draft.notice_until_local is null then
      raise exception 'the notice is missing its text or its end' using errcode = '23514', hint = 'incomplete';
    end if;
    -- An end still to come, at most 90 days after it starts to count (now, or «desde»).
    select t.timezone into v_timezone from public.tenants t where t.id = p_tenant_id;
    v_until_at := v_draft.notice_until_local at time zone v_timezone;
    v_from_at := v_draft.notice_from_local at time zone v_timezone;
    if v_until_at <= now()
       or v_until_at - greatest(now(), coalesce(v_from_at, now())) > interval '90 days' then
      raise exception 'the notice already ended or lasts more than 90 days'
        using errcode = '23514', hint = 'validity';
    end if;
  elsif v_item.kind = 'service' then
    -- Visitors need to find it: its address in words or its place on the map (ADR-069).
    if v_draft.service_category is null
       or (coalesce(v_draft.address_line, '') = '' and v_draft.latitude is null) then
      raise exception 'the service is missing how to find it' using errcode = '23514', hint = 'incomplete';
    end if;
  -- Visitors need a summary and a location; events also need their date.
  elsif v_draft.summary = '' or v_draft.latitude is null
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


-- «Retirar»: also a service that closed; its sealed revisions stay for «Volver a esta versión».
create or replace function public.retire_content(p_tenant_id uuid, p_content_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.content_items%rowtype;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;
  if v_item.kind not in ('knowledge', 'notice', 'service') then
    raise exception 'only knowledge, notices and services can be retired' using errcode = '23514', hint = 'kind';
  end if;
  if v_item.published_revision_id is null then
    raise exception 'it is not published' using errcode = 'PT409';
  end if;

  update public.content_items i
  set published_revision_id = null, published_at = null, updated_at = now()
  where i.id = p_content_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'content.retired', 'content_item', p_content_id,
          'success', jsonb_build_object('kind', v_item.kind, 'revision_id', v_item.published_revision_id));
end;
$$;


-- ── 6. The indexer: the category, the contact and the address ──────────────

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
      'validity', case when i.kind = 'notice' then jsonb_build_object(
                    'from', to_char(r.notice_from_local, 'YYYY-MM-DD"T"HH24:MI'),
                    'until', to_char(r.notice_until_local, 'YYYY-MM-DD"T"HH24:MI')) end,
      'service', case when i.kind = 'service' then jsonb_build_object(
                   'category', r.service_category,
                   'phone', r.contact_phone,
                   'whatsapp', r.contact_whatsapp,
                   'address', r.address_line) end,
      'placeTitle', (
        select pr.title from public.content_items pi
        join public.content_revisions pr on pr.id = pi.published_revision_id
        where pi.tenant_id = r.tenant_id and pi.id = r.notice_place_id
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


-- ── 7. The portal: the published services ───────────────────────────────────

-- Anonymous, active municipalities only. In the platform's order of categories, then by name.
create function public.portal_services(p_tenant_id uuid)
returns table (
  slug      text,
  title     text,
  summary   text,
  category  text,
  hours     jsonb,
  phone     text,
  whatsapp  text,
  address   text,
  latitude  double precision,
  longitude double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.slug, r.title, r.summary, r.service_category, r.opening_hours,
         r.contact_phone, r.contact_whatsapp, r.address_line, r.latitude, r.longitude
  from public.content_items s
  join public.tenants t on t.id = s.tenant_id and t.status = 'active'
  join public.content_revisions r
    on r.id = s.published_revision_id and r.content_id = s.id and r.state = 'sealed'
  where s.tenant_id = p_tenant_id
    and s.kind = 'service'
  order by array_position(
             array['food', 'lodging', 'cash', 'transport', 'fuel', 'health', 'tourist_info', 'other'],
             r.service_category),
           r.title, s.slug
  limit 300;
$$;

revoke all on function public.portal_services(uuid) from public, anon, authenticated;
grant execute on function public.portal_services(uuid) to anon, authenticated;
