-- A · Paso 1.1 (ADR-069): the municipality's notices — a road cut, a fair called off, a change
-- of opening hours — with an end the assistant and the portal respect on their own.
--
--   * A notice is content of kind 'notice': draft → publish → sealed revisions, «Volver a
--     esta versión», «Retirar» and audit, like everything else. Only owners and admins
--     publish it; editors prepare the draft.
--   * Its validity is local to the municipality: «desde» (optional) and «hasta» (required to
--     publish), at most 90 days apart; renewing is publishing another version.
--   * «Vigente» is checked when reading, never by a job: the published revision has no
--     «desde» or it already came, and its «hasta» did not. The assistant's search, its
--     notices for a place and the portal only ever see notices in force.
--   * A notice may name a place: a destination or an event of the same municipality.
--
-- Expand only: three nullable columns, new functions, and the functions that branch on the
-- kind of content replaced with one more branch (same signatures, same answers for the
-- kinds that already existed).

-- ── Validity and place on revisions ────────────────────────────────────────

alter table public.content_revisions
  add column notice_from_local  timestamp,
  add column notice_until_local timestamp,
  add column notice_place_id    uuid,
  add constraint content_revisions_notice_validity check (
    notice_from_local is null or notice_until_local is null
    or (notice_until_local > notice_from_local
        and notice_until_local - notice_from_local <= interval '90 days')
  ),
  add constraint content_revisions_notice_place_fkey foreign key (tenant_id, notice_place_id)
    references public.content_items (tenant_id, id) on delete restrict;

create index content_revisions_notice_place_idx on public.content_revisions (tenant_id, notice_place_id)
  where notice_place_id is not null;

-- {from, until} → local bounds, or no row when invalid. Each is null or "YYYY-MM-DDTHH:MM"
-- (an existing minute, exact round trip); «hasta» after «desde», at most 90 days apart.
-- STABLE, not IMMUTABLE: text → timestamp casts depend on session settings.
create function private.parse_notice_validity(p jsonb)
returns table (from_local timestamp, until_local timestamp)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_pattern constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$';
  v_format constant text := 'YYYY-MM-DD"T"HH24:MI';
  v_from timestamp;
  v_until timestamp;
begin
  if p is null or jsonb_typeof(p) <> 'object'
     or not private.has_exact_keys(p, array['from', 'until'])
     or jsonb_typeof(p -> 'from') not in ('null', 'string')
     or jsonb_typeof(p -> 'until') not in ('null', 'string') then
    return;
  end if;
  if jsonb_typeof(p -> 'from') = 'string' then
    if (p ->> 'from') !~ v_pattern then
      return;
    end if;
    begin
      v_from := (p ->> 'from')::timestamp;
    exception when others then
      return;
    end;
    if to_char(v_from, v_format) <> (p ->> 'from') or extract(year from v_from) not between 2000 and 2100 then
      return;
    end if;
  end if;
  if jsonb_typeof(p -> 'until') = 'string' then
    if (p ->> 'until') !~ v_pattern then
      return;
    end if;
    begin
      v_until := (p ->> 'until')::timestamp;
    exception when others then
      return;
    end;
    if to_char(v_until, v_format) <> (p ->> 'until') or extract(year from v_until) not between 2000 and 2100 then
      return;
    end if;
  end if;
  if v_from is not null and v_until is not null
     and (v_until <= v_from or v_until - v_from > interval '90 days') then
    return;
  end if;
  return query select v_from, v_until;
end;
$$;

revoke all on function private.parse_notice_validity(jsonb) from public;

-- In force now, with the database's clock and the municipality's time zone.
create function private.notice_is_active(p_from timestamp, p_until timestamp, p_timezone text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_until is not null
    and (p_until at time zone p_timezone) > now()
    and (p_from is null or (p_from at time zone p_timezone) <= now());
$$;

revoke all on function private.notice_is_active(timestamp, timestamp, text) from public;

-- What the editor saves (mirror of @rikuy/core noticeDocumentSchema). «Hasta» may still be
-- empty in a draft; publishing asks for it.
create function private.is_valid_notice_draft(p jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'object'
    and private.has_exact_keys(p, array['title', 'summary', 'body', 'validity', 'placeId'])
    and private.is_plain_line(p -> 'title', 1, 120)
    and private.is_plain_line(p -> 'summary', 0, 300)
    and private.is_valid_rich_text(p -> 'body')
    and exists (select 1 from private.parse_notice_validity(p -> 'validity'))
    and (jsonb_typeof(p -> 'placeId') = 'null'
         or (jsonb_typeof(p -> 'placeId') = 'string'
             and (p ->> 'placeId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
    false
  );
$$;

revoke all on function private.is_valid_notice_draft(jsonb) from public;

-- ── The draft as the editor knows it: one more branch ──────────────────────

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

-- ── Saving: the notice's validity and place ────────────────────────────────

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
      body = p_document -> 'body',
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

-- ── Publishing: a notice needs its text and an end still to come ───────────

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

-- «Retirar»: knowledge and notices («la ruta ya se abrió») leave at once; their sealed
-- revisions stay, so «Volver a esta versión» publishes them again.
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
  if v_item.kind not in ('knowledge', 'notice') then
    raise exception 'only knowledge and notices can be retired' using errcode = '23514', hint = 'kind';
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

-- ── The assistant: only notices in force, a little ahead of the rest ────────

-- Same signature and visibility as before (ADR-037, ADR-038), plus: a notice's fragments are
-- visible only while it is in force, and a notice that matches weighs a little more, so it
-- is among the passages the assistant reads (it is put first there, ADR-069).
create or replace function private.search_knowledge(p_tenant_id uuid, p_query text, p_limit integer)
returns table (
  chunk_id        uuid,
  source          text,
  source_id       uuid,
  source_version  integer,
  kind            public.content_kind,
  slug            text,
  title           text,
  heading         text,
  body            text,
  page_from       integer,
  page_to         integer,
  scene_id        uuid,
  hotspot_id      uuid,
  ended           boolean,
  score           real
)
language sql
stable
security definer
set search_path = ''
as $$
  with terms as (
    select t.terms,
           array_to_string(array(select quote_literal(x) from unnest(t.terms) x), ' | ')::tsquery as q
    from (select private.knowledge_terms(p_query) as terms) t
    where cardinality(t.terms) > 0
  ),
  visible as materialized (
    select c.id, 'content'::text as source, i.id as source_id, r.revision_no, i.kind, i.slug,
           c.title, c.heading, c.body, c.page_from, c.page_to, c.scene_id, c.hotspot_id,
           i.kind = 'event' and coalesce(private.event_ends_at(r.ends_local, r.all_day, tn.timezone) <= now(), false) as ended,
           c.search
    from public.knowledge_chunks c
    join public.content_items i
      on i.tenant_id = c.tenant_id and i.id = c.content_id and i.published_revision_id = c.content_revision_id
    join public.content_revisions r on r.id = c.content_revision_id
    join public.tenants tn on tn.id = c.tenant_id
    where c.tenant_id = p_tenant_id
      and (i.kind <> 'notice'
           or private.notice_is_active(r.notice_from_local, r.notice_until_local, tn.timezone))
    union all
    select c.id, 'tour'::text, t.id, tr.revision_no, i.kind, i.slug,
           c.title, c.heading, c.body, c.page_from, c.page_to, c.scene_id, c.hotspot_id,
           i.kind = 'event' and coalesce(private.event_ends_at(cr.ends_local, cr.all_day, tn.timezone) <= now(), false),
           c.search
    from public.knowledge_chunks c
    join public.tours t
      on t.tenant_id = c.tenant_id and t.id = c.tour_id and t.published_revision_id = c.tour_revision_id
    join public.tour_revisions tr on tr.id = c.tour_revision_id
    join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
    join public.content_revisions cr on cr.id = i.published_revision_id and cr.state = 'sealed'
    join public.tenants tn on tn.id = c.tenant_id
    where c.tenant_id = p_tenant_id
  ),
  -- How rare each word is among what is visible now (BM25's idf): «wifi» weighs more than
  -- «lugar», which half the fragments have.
  weights as (
    select x.term,
           ln(1 + ((select count(*) from visible)::real - count(v.id) + 0.5) / (count(v.id) + 0.5))::real as idf
    from terms
    cross join unnest(terms.terms) as x(term)
    left join visible v on v.search @@ quote_literal(x.term)::tsquery
    group by x.term
  )
  select v.id, v.source, v.source_id, v.revision_no, v.kind, v.slug, v.title, v.heading, v.body,
         v.page_from, v.page_to, v.scene_id, v.hotspot_id, v.ended,
         (
           -- The question's words the fragment has, each by how rare it is; then how densely;
           -- a notice in force a little ahead.
           (select coalesce(sum(w.idf), 0) from weights w where v.search @@ quote_literal(w.term)::tsquery)::real
           + ts_rank_cd(v.search, terms.q, 32)
           + case when v.kind = 'notice' then 0.5 else 0 end
         )::real as score
  from visible v
  cross join terms
  where v.search @@ terms.q
  order by score desc, v.id
  limit greatest(1, least(coalesce(p_limit, 8), 20));
$$;

-- The notices in force that name a published destination or event (its page, or its tour):
-- the assistant reads them even when the question does not mention them (ADR-069). The first
-- fragment of each, the one that ends sooner first, at most two. Only municipalities online.
create function ai_api.place_notices(p_tenant_id uuid, p_kind text, p_slug text)
returns table (
  chunk_id        uuid,
  source          text,
  source_id       uuid,
  source_version  integer,
  kind            public.content_kind,
  slug            text,
  title           text,
  heading         text,
  body            text,
  page_from       integer,
  page_to         integer,
  scene_id        uuid,
  hotspot_id      uuid,
  ended           boolean,
  score           real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_kind is null or p_kind not in ('destination', 'event') or p_slug is null
     or not exists (select 1 from public.tenants t where t.id = p_tenant_id and t.status = 'active') then
    return;
  end if;
  return query
  select x.chunk_id, x.source, x.source_id, x.source_version, x.kind, x.slug, x.title, x.heading,
         x.body, x.page_from, x.page_to, x.scene_id, x.hotspot_id, x.ended, x.score
  from (
    select distinct on (n.id)
           c.id as chunk_id, 'content'::text as source, n.id as source_id, r.revision_no as source_version,
           n.kind, n.slug, c.title, c.heading, c.body, c.page_from, c.page_to, c.scene_id, c.hotspot_id,
           false as ended, 1::real as score, r.notice_until_local as until_local
    from public.content_items p
    join public.content_revisions r on r.tenant_id = p.tenant_id and r.notice_place_id = p.id
    join public.content_items n
      on n.tenant_id = r.tenant_id and n.id = r.content_id and n.published_revision_id = r.id
     and n.kind = 'notice'
    join public.knowledge_chunks c on c.tenant_id = n.tenant_id and c.content_revision_id = r.id
    join public.tenants tn on tn.id = p.tenant_id
    where p.tenant_id = p_tenant_id
      and p.kind::text = p_kind
      and p.slug = p_slug
      and p.published_revision_id is not null
      and private.notice_is_active(r.notice_from_local, r.notice_until_local, tn.timezone)
    order by n.id, c.chunk_no
  ) x
  order by x.until_local, x.chunk_id
  limit 2;
end;
$$;

revoke all on function ai_api.place_notices(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function ai_api.place_notices(uuid, text, text) to rikuy_ai;

-- ── The indexer: the notice's validity and place in words ──────────────────

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

-- ── The portal: the notices in force (and those that start within a day) ───

-- Anonymous, active municipalities only. The pages are cached (ADR-024): each notice comes
-- with its instants, and the browser shows only those in force at that moment — a cached page
-- never shows a notice that ended or one that has not started. Its place only when published.
create function public.portal_notices(p_tenant_id uuid)
returns table (
  slug        text,
  title       text,
  summary     text,
  body        jsonb,
  starts_at   timestamptz,
  ends_at     timestamptz,
  place_kind  text,
  place_slug  text,
  place_title text
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.slug, r.title, r.summary, r.body,
         r.notice_from_local at time zone t.timezone,
         r.notice_until_local at time zone t.timezone,
         p.kind::text, p.slug, pr.title
  from public.content_items n
  join public.tenants t on t.id = n.tenant_id and t.status = 'active'
  join public.content_revisions r
    on r.id = n.published_revision_id and r.content_id = n.id and r.state = 'sealed'
  left join public.content_items p
    on p.tenant_id = r.tenant_id and p.id = r.notice_place_id and p.published_revision_id is not null
  left join public.content_revisions pr on pr.id = p.published_revision_id
  where n.tenant_id = p_tenant_id
    and n.kind = 'notice'
    and r.notice_until_local is not null
    and (r.notice_until_local at time zone t.timezone) > now()
    and (r.notice_from_local is null
         or (r.notice_from_local at time zone t.timezone) <= now() + interval '1 day')
  order by r.notice_until_local at time zone t.timezone, n.slug
  limit 20;
$$;

revoke all on function public.portal_notices(uuid) from public, anon, authenticated;
grant execute on function public.portal_notices(uuid) to anon, authenticated;
