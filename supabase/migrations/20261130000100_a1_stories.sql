-- A · Paso 1.3 (ADR-069): the community's memory — stories that neighbours tell about their
-- municipality, loaded by the municipality's team on their behalf.
--
--   * A story is content of kind 'story', in the module «Memoria de la comunidad»
--     (`community_memory`): draft → publish → sealed revisions, «Volver a esta versión»,
--     «Retirar» and audit, like everything else. Only owners and admins publish it.
--   * It has a title, a text, who tells it (or «anónimo», and then no name is kept), their
--     community or relation with the place, an optional destination it is about, and the
--     person's consent: without it, it is not published; the sealed revision and the audit keep it.
--   * The portal reads them with portal_stories (anonymous, active municipalities); the assistant
--     reads its indexed text, which says whose story it is.
--
-- Expand only: five nullable columns, a module, new functions, and the functions that branch on
-- the kind of content replaced with one more branch (same signatures, same answers for the kinds
-- that already existed).

-- ── 1. The module ───────────────────────────────────────────────────────────

insert into public.platform_modules (key, position, requires) values ('community_memory', 10, null);

-- Every municipality that exists gets it, like every module (ADR-060, ADR-069).
insert into public.tenant_modules (tenant_id, module)
select t.id, 'community_memory' from public.tenants t
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
  elsif new.kind = 'story' then
    perform private.assert_module(new.tenant_id, 'community_memory');
  end if;
  return new;
end;
$$;

-- ── 2. What a story has, on its revisions ───────────────────────────────────

alter table public.content_revisions
  add column story_author    text,
  add column story_anonymous boolean,
  add column story_community text,
  add column story_place_id  uuid,
  add column story_consent   boolean,
  add constraint content_revisions_story_author check (
    story_author is null or char_length(story_author) between 1 and 80
  ),
  add constraint content_revisions_story_community check (
    story_community is null or char_length(story_community) between 1 and 120
  ),
  -- «Anónimo» keeps no name.
  add constraint content_revisions_story_anonymous check (
    not coalesce(story_anonymous, false) or story_author is null
  ),
  add constraint content_revisions_story_place_fkey foreign key (tenant_id, story_place_id)
    references public.content_items (tenant_id, id) on delete restrict;

create index content_revisions_story_place_idx on public.content_revisions (tenant_id, story_place_id)
  where story_place_id is not null;

-- What the editor saves (mirror of @rikuy/core storyDocumentSchema).
create function private.is_valid_story_draft(p jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'object'
    and private.has_exact_keys(
      p, array['title', 'summary', 'body', 'author', 'anonymous', 'community', 'placeId', 'consent'])
    and private.is_plain_line(p -> 'title', 1, 120)
    and private.is_plain_line(p -> 'summary', 0, 300)
    and private.is_valid_rich_text(p -> 'body')
    and private.is_plain_line(p -> 'author', 0, 80)
    and jsonb_typeof(p -> 'anonymous') = 'boolean'
    and private.is_plain_line(p -> 'community', 0, 120)
    and jsonb_typeof(p -> 'consent') = 'boolean'
    and (jsonb_typeof(p -> 'placeId') = 'null'
         or (jsonb_typeof(p -> 'placeId') = 'string'
             and (p ->> 'placeId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
    false
  );
$$;

revoke all on function private.is_valid_story_draft(jsonb) from public;

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


-- ── 4. Saving: what a story has ─────────────────────────────────────────────

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


-- ── 5. Publishing: a text, who tells it and the person's consent ─────────────

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
  elsif v_item.kind = 'story' then
    -- A text, who tells it (or «anónimo») and the person's consent (ADR-069).
    if v_draft.body = '[]'::jsonb
       or not (coalesce(v_draft.story_anonymous, false) or coalesce(v_draft.story_author, '') <> '') then
      raise exception 'the story is missing its text or who tells it' using errcode = '23514', hint = 'incomplete';
    end if;
    if not coalesce(v_draft.story_consent, false) then
      raise exception 'the person did not agree to publish the story' using errcode = '23514', hint = 'consent';
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
                             'previous_revision_id', v_item.published_revision_id)
          -- A story records the consent it was published with (ADR-069).
          || case when v_item.kind = 'story' then jsonb_build_object(
               'consent', v_draft.story_consent,
               'anonymous', coalesce(v_draft.story_anonymous, false)) else '{}'::jsonb end);

  return query select v_draft.id, v_draft.revision_no;
end;
$$;


-- «Retirar»: also a story (the person asked to take it down).
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
  if v_item.kind not in ('knowledge', 'notice', 'service', 'story') then
    raise exception 'only knowledge, notices, services and stories can be retired'
      using errcode = '23514', hint = 'kind';
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


-- ── 6. The indexer: whose story it is ───────────────────────────────────────

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


-- ── 7. The portal: the published stories ────────────────────────────────────

-- Anonymous, active municipalities only. The newest first; the destination only when it is
-- published.
create function public.portal_stories(p_tenant_id uuid)
returns table (
  slug         text,
  title        text,
  summary      text,
  body         jsonb,
  author       text,
  anonymous    boolean,
  community    text,
  place_slug   text,
  place_title  text,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.slug, r.title, r.summary, r.body,
         case when coalesce(r.story_anonymous, false) then null else r.story_author end,
         coalesce(r.story_anonymous, false), r.story_community,
         p.slug, pr.title, s.published_at
  from public.content_items s
  join public.tenants t on t.id = s.tenant_id and t.status = 'active'
  join public.content_revisions r
    on r.id = s.published_revision_id and r.content_id = s.id and r.state = 'sealed'
  left join public.content_items p
    on p.tenant_id = r.tenant_id and p.id = r.story_place_id and p.published_revision_id is not null
  left join public.content_revisions pr on pr.id = p.published_revision_id
  where s.tenant_id = p_tenant_id
    and s.kind = 'story'
  order by s.published_at desc, s.slug
  limit 200;
$$;

revoke all on function public.portal_stories(uuid) from public, anon, authenticated;
grant execute on function public.portal_stories(uuid) to anon, authenticated;
