-- C3 · Paso 3 — Inicio por secciones y categorías (ADR-062). Solo expand.
--
-- 1. Categories of the municipality. Each municipality defines its own list of categories
--    for destinations and for events (owners and admins, in the panel). A destination or an
--    event picks at most one in its revision, so the category is published with the rest of
--    the content and «Volver a esta versión» brings it back. A category is never deleted:
--    removing it archives it, the portal stops showing it and the revisions that pointed at it
--    simply have no category there.
-- 2. The portal's home is data of the brand (`home`, optional): the cover (text, or the photo
--    of a destination the municipality picks), up to two figures written by the municipality,
--    and which sections follow, in which order and variant. A brand without `home` keeps the
--    platform's default. Section keys and variants are fixed values: nothing the municipality
--    writes becomes markup, CSS or a link.
-- 3. `portal_content_index` (anonymous): ids, addresses and categories of what is published,
--    for the filters and the home's cover.

-- ── Categories ─────────────────────────────────────────────────────────────

create table public.content_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  kind        public.content_kind not null,
  name        text not null,
  position    integer not null,
  archived_at timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint content_categories_tenant_id_id_key unique (tenant_id, id),
  constraint content_categories_kind check (kind in ('destination', 'event')),
  constraint content_categories_name check (
    char_length(btrim(name)) between 1 and 40 and name = btrim(name) and name !~ '[[:cntrl:]]'
  ),
  constraint content_categories_position check (position between 1 and 20)
);

-- Names are unique (ignoring case) among the categories in use of one kind.
create unique index content_categories_active_name_key
  on public.content_categories (tenant_id, kind, lower(name)) where archived_at is null;

alter table public.content_categories enable row level security;
revoke all on public.content_categories from public, anon, authenticated, service_role;

-- The category of a revision (destinations and events). Categories are never deleted, so
-- the reference of a sealed revision always resolves.
alter table public.content_revisions add column category_id uuid;
alter table public.content_revisions
  add constraint content_revisions_category_fkey foreign key (tenant_id, category_id)
    references public.content_categories (tenant_id, id) on delete restrict;
create index content_revisions_category_idx on public.content_revisions (tenant_id, category_id)
  where category_id is not null;

-- Every category of the municipality, with how many items use it (any member).
create function public.tenant_content_categories(p_tenant_id uuid)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id,
             'kind', c.kind,
             'name', c.name,
             'position', c.position,
             -- Items whose working revision (draft, else published) uses it.
             'used', (
               select count(*)::integer
               from public.content_items i
               join public.content_revisions r
                 on r.id = coalesce(i.draft_revision_id, i.published_revision_id)
               where i.tenant_id = c.tenant_id and r.category_id = c.id
             )
           ) order by c.kind, c.position)
    from public.content_categories c
    where c.tenant_id = p_tenant_id and c.archived_at is null
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.tenant_content_categories(uuid) from public, anon, authenticated;
grant execute on function public.tenant_content_categories(uuid) to authenticated;

-- Replaces the list of categories of one kind (owners and admins), in the given order:
-- `[{"id": uuid?, "name": text}]`. A category with an id keeps it (renamed if needed); one
-- without id is new; one missing from the list is archived.
create function public.save_content_categories(p_tenant_id uuid, p_kind text, p_categories jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_position integer := 0;
  v_id uuid;
  v_name text;
  v_kept uuid[] := '{}';
  v_before jsonb;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  if p_kind is null or p_kind not in ('destination', 'event') then
    raise exception 'unknown kind of category' using errcode = '23514', hint = 'kind';
  end if;
  if jsonb_typeof(p_categories) is distinct from 'array' or jsonb_array_length(p_categories) > 20 then
    raise exception 'a list of up to 20 categories' using errcode = '23514', hint = 'list';
  end if;

  -- One writer at a time per municipality.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;

  select coalesce(jsonb_agg(c.name order by c.position), '[]'::jsonb) into v_before
  from public.content_categories c
  where c.tenant_id = p_tenant_id and c.kind::text = p_kind and c.archived_at is null;

  -- Names are checked before anything changes (the unique index would also catch a clash,
  -- but only halfway through the list).
  for v_item in select value from jsonb_array_elements(p_categories) loop
    if not (
      private.has_exact_keys(v_item, array['name'], array['id'])
      and private.is_plain_line(v_item -> 'name', 1, 40)
      and (v_item ->> 'name') = btrim(v_item ->> 'name')
      and (not (v_item ? 'id') or (
        jsonb_typeof(v_item -> 'id') = 'string'
        and (v_item ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ))
    ) then
      raise exception 'invalid category' using errcode = '23514', hint = 'category';
    end if;
  end loop;
  if (select count(distinct lower(value ->> 'name')) from jsonb_array_elements(p_categories))
     <> jsonb_array_length(p_categories) then
    raise exception 'two categories with the same name' using errcode = '23505', hint = 'duplicate';
  end if;
  if (select count(distinct value ->> 'id') from jsonb_array_elements(p_categories) where value ? 'id')
     <> (select count(*) from jsonb_array_elements(p_categories) where value ? 'id') then
    raise exception 'the same category twice' using errcode = '23514', hint = 'category';
  end if;

  -- Ids must be categories of this municipality and kind, still in use.
  for v_item in select value from jsonb_array_elements(p_categories) where value ? 'id' loop
    if not exists (
      select 1 from public.content_categories c
      where c.tenant_id = p_tenant_id and c.id = (v_item ->> 'id')::uuid
        and c.kind::text = p_kind and c.archived_at is null
    ) then
      raise exception 'not a category of this tenant' using errcode = '23514', hint = 'category';
    end if;
    v_kept := v_kept || (v_item ->> 'id')::uuid;
  end loop;

  -- Archive what is gone first, and park positions, so names and positions never clash
  -- midway.
  update public.content_categories c
  set archived_at = now(), updated_at = now()
  where c.tenant_id = p_tenant_id and c.kind::text = p_kind and c.archived_at is null
    and c.id <> all (v_kept);
  update public.content_categories c
  set name = c.id::text, position = 20
  where c.tenant_id = p_tenant_id and c.id = any (v_kept);

  for v_item in select value from jsonb_array_elements(p_categories) loop
    v_position := v_position + 1;
    v_name := v_item ->> 'name';
    if v_item ? 'id' then
      v_id := (v_item ->> 'id')::uuid;
      update public.content_categories c
      set name = v_name, position = v_position, updated_at = now()
      where c.tenant_id = p_tenant_id and c.id = v_id;
    else
      insert into public.content_categories (tenant_id, kind, name, position, created_by)
      values (p_tenant_id, p_kind::public.content_kind, v_name, v_position, (select auth.uid()));
    end if;
  end loop;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'content.categories_saved', 'tenant', p_tenant_id,
          'success', jsonb_build_object(
            'kind', p_kind,
            'before', v_before,
            'after', coalesce((select jsonb_agg(value ->> 'name') from jsonb_array_elements(p_categories)), '[]'::jsonb)
          ));

  return public.tenant_content_categories(p_tenant_id);
end;
$$;

revoke all on function public.save_content_categories(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_content_categories(uuid, text, jsonb) to authenticated;

-- ── The category in destination and event drafts ───────────────────────────

-- The destination's draft: as before, and `categoryId` (optional, null or a uuid).
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
    private.has_exact_keys(p, array['title', 'summary', 'body', 'location', 'cover', 'gallery'], array['hours', 'categoryId'])
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

-- The event's draft: as before, and `categoryId` (optional). Opening hours stay for
-- destinations only.
create or replace function private.is_valid_event_draft(p jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    private.has_exact_keys(p, array['title', 'summary', 'body', 'schedule', 'venueId', 'location', 'cover', 'gallery'], array['categoryId'])
    and private.is_valid_destination_draft(p - 'schedule' - 'venueId')
    and (jsonb_typeof(p -> 'schedule') = 'null'
         or exists (select 1 from private.parse_event_schedule(p -> 'schedule')))
    and (jsonb_typeof(p -> 'venueId') = 'null'
         or (jsonb_typeof(p -> 'venueId') = 'string'
             and (p ->> 'venueId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
    false
  );
$$;

-- The draft as the editor knows it: `categoryId` only when it has one (the document is
-- unchanged otherwise, so the panel already deployed keeps working during the deploy).
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

-- ── The portal's index ─────────────────────────────────────────────────────

-- Every published destination and event of an active municipality with its id and its
-- category (if it has one still in use), for the filters and the home's cover (anonymous).
create function public.portal_content_index(p_tenant_id uuid)
returns table (
  kind text,
  content_id uuid,
  slug text,
  category_id uuid,
  category_name text,
  category_position integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.kind::text, i.id, i.slug, c.id, c.name, c.position
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  left join public.content_categories c
    on c.tenant_id = r.tenant_id and c.id = r.category_id
   and c.kind = i.kind and c.archived_at is null
  where i.tenant_id = p_tenant_id
    and i.kind in ('destination', 'event')
    and r.state = 'sealed'
  order by i.kind, i.slug;
$$;

revoke all on function public.portal_content_index(uuid) from public, anon, authenticated;
grant execute on function public.portal_content_index(uuid) to anon, authenticated;

-- ── The home in the brand ──────────────────────────────────────────────────

-- `home` (optional): the cover, up to two figures and the sections after it.
--   hero:     {"variant": "text" | "photo", "destinationId": uuid | null}
--             (photo with no destination: the first published destination with a photo)
--   figures:  [{"value": text (1–12), "label": text (1–60)}], up to 2
--   sections: [{"key": …, "variant": …}], up to 6, each key once, in their order:
--             figures (band) · destinations (grid | featured) · events (list | cards) ·
--             tours (banner) · passport (banner) · assistant (banner)
create function private.is_valid_home(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if not (
    private.has_exact_keys(p, array['hero', 'figures', 'sections'])
    and private.has_exact_keys(p -> 'hero', array['variant', 'destinationId'])
    and jsonb_typeof(p #> '{hero,variant}') = 'string'
    and coalesce(p #>> '{hero,variant}' in ('text', 'photo'), false)
    and (
      jsonb_typeof(p #> '{hero,destinationId}') = 'null'
      or (
        jsonb_typeof(p #> '{hero,destinationId}') = 'string'
        and (p #>> '{hero,destinationId}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
    and jsonb_typeof(p -> 'figures') = 'array'
    and jsonb_array_length(p -> 'figures') <= 2
    and jsonb_typeof(p -> 'sections') = 'array'
    and jsonb_array_length(p -> 'sections') <= 6
  ) then
    return false;
  end if;

  for v_item in select value from jsonb_array_elements(p -> 'figures') loop
    if not (
      private.has_exact_keys(v_item, array['value', 'label'])
      and private.is_plain_line(v_item -> 'value', 1, 12)
      and private.is_plain_line(v_item -> 'label', 1, 60)
    ) then
      return false;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p -> 'sections') loop
    if not (
      private.has_exact_keys(v_item, array['key', 'variant'])
      and jsonb_typeof(v_item -> 'key') = 'string'
      and jsonb_typeof(v_item -> 'variant') = 'string'
      and coalesce((v_item ->> 'key', v_item ->> 'variant') in (
        ('figures', 'band'),
        ('destinations', 'grid'), ('destinations', 'featured'),
        ('events', 'list'), ('events', 'cards'),
        ('tours', 'banner'),
        ('passport', 'banner'),
        ('assistant', 'banner')
      ), false)
    ) then
      return false;
    end if;
  end loop;

  return (select count(distinct value ->> 'key') from jsonb_array_elements(p -> 'sections'))
         = jsonb_array_length(p -> 'sections');
end;
$$;

revoke all on function private.is_valid_home(jsonb) from public;

create or replace function private.is_valid_presentation(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_radius integer;
begin
  if not private.has_exact_keys(p, array['identity', 'theme', 'contact', 'social', 'seo'], array['logo', 'visitors', 'assistant', 'home']) then
    return false;
  end if;

  -- home (optional, ADR-062): the cover, figures and sections of the portal's home
  if p ? 'home' and not coalesce(private.is_valid_home(p -> 'home'), false) then
    return false;
  end if;

  -- logo (optional): a reference to an image asset version, never a URL
  if p ? 'logo' and not (
    private.has_exact_keys(p -> 'logo', array['assetId', 'version'])
    and jsonb_typeof(p #> '{logo,assetId}') = 'string'
    and coalesce((p #>> '{logo,assetId}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
    and jsonb_typeof(p #> '{logo,version}') = 'number'
    and coalesce((p #>> '{logo,version}') ~ '^[1-9][0-9]{0,5}$', false)
  ) then
    return false;
  end if;

  -- visitors (optional): whole meters between 50 and 1000
  if p ? 'visitors' then
    if not (
      private.has_exact_keys(p -> 'visitors', array['nearbyRadius'])
      and jsonb_typeof(p #> '{visitors,nearbyRadius}') = 'number'
      and coalesce((p #>> '{visitors,nearbyRadius}') ~ '^[1-9][0-9]{1,3}$', false)
    ) then
      return false;
    end if;
    v_radius := (p #>> '{visitors,nearbyRadius}')::integer;
    if v_radius < 50 or v_radius > 1000 then
      return false;
    end if;
  end if;

  -- assistant (optional): the visitor assistant's persona. Plain lines only; the tone is one
  -- of two fixed values, so no text of the municipality ever becomes an instruction.
  if p ? 'assistant' and not (
    private.has_exact_keys(p -> 'assistant', array['name', 'greeting', 'tone'])
    and private.is_plain_line(p #> '{assistant,name}', 1, 40)
    and private.is_plain_line(p #> '{assistant,greeting}', 0, 240)
    and jsonb_typeof(p #> '{assistant,tone}') = 'string'
    and coalesce(p #>> '{assistant,tone}' in ('warm', 'formal'), false)
  ) then
    return false;
  end if;

  -- identity
  if not (
    private.has_exact_keys(p -> 'identity', array['siteName', 'shortName', 'tagline'])
    and private.is_plain_line(p #> '{identity,siteName}', 1, 60)
    and private.is_plain_line(p #> '{identity,shortName}', 1, 12)
    and private.is_plain_line(p #> '{identity,tagline}', 0, 140)
  ) then
    return false;
  end if;

  -- theme: colors are lowercase #rrggbb, so they are safe inside CSS. The style (optional,
  -- ADR-061) is one of two fixed values; «immersive» exists only on a dark background.
  if not (
    private.has_exact_keys(p -> 'theme', array['mode', 'brand', 'accent'], array['style'])
    and coalesce(p #>> '{theme,mode}' in ('light', 'dark'), false)
    and coalesce((p #>> '{theme,brand}') ~ '^#[0-9a-f]{6}$', false)
    and coalesce((p #>> '{theme,accent}') ~ '^#[0-9a-f]{6}$', false)
    and jsonb_typeof(p #> '{theme,brand}') = 'string'
    and jsonb_typeof(p #> '{theme,accent}') = 'string'
    and (
      not (p -> 'theme' ? 'style')
      or (
        jsonb_typeof(p #> '{theme,style}') = 'string'
        and coalesce(p #>> '{theme,style}' in ('editorial', 'immersive'), false)
        and (p #>> '{theme,style}' <> 'immersive' or p #>> '{theme,mode}' = 'dark')
      )
    )
  ) then
    return false;
  end if;

  -- contact: every key optional
  if not private.has_exact_keys(p -> 'contact', array[]::text[], array['email', 'phone', 'address']) then
    return false;
  end if;
  if p -> 'contact' ? 'email' and not (
    private.is_plain_line(p #> '{contact,email}', 3, 254)
    and (p #>> '{contact,email}') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    return false;
  end if;
  if p -> 'contact' ? 'phone' and not (
    jsonb_typeof(p #> '{contact,phone}') = 'string'
    and (p #>> '{contact,phone}') ~ '^\+?[0-9][0-9 ()-]{5,29}$'
  ) then
    return false;
  end if;
  if p -> 'contact' ? 'address' and not private.is_plain_line(p #> '{contact,address}', 1, 160) then
    return false;
  end if;

  -- social: up to 5 https links, one per network
  if jsonb_typeof(p -> 'social') <> 'array' or jsonb_array_length(p -> 'social') > 5 then
    return false;
  end if;
  for v_item in select value from jsonb_array_elements(p -> 'social') loop
    if not (
      private.has_exact_keys(v_item, array['network', 'url'])
      and coalesce(v_item ->> 'network' in ('facebook', 'instagram', 'tiktok', 'youtube', 'x'), false)
      and private.is_plain_line(v_item -> 'url', 9, 300)
      -- https, no userinfo in the authority, no whitespace anywhere
      and (v_item ->> 'url') ~ '^https://[^/@?#[:space:]]+([/?#][^[:space:]]*)?$'
    ) then
      return false;
    end if;
  end loop;
  if (select count(distinct value ->> 'network') from jsonb_array_elements(p -> 'social'))
     <> jsonb_array_length(p -> 'social') then
    return false;
  end if;

  -- seo
  return private.has_exact_keys(p -> 'seo', array['description'])
    and private.is_plain_line(p #> '{seo,description}', 0, 160);
end;
$$;

revoke all on function private.is_valid_presentation(jsonb) from public;

-- The cover's destination is a destination of the same municipality (it may be unpublished:
-- the portal then shows the text cover). Checked on every write of the brand.
create function private.home_destination_of_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(new.branding #> '{home,hero,destinationId}') = 'string' and not exists (
    select 1 from public.content_items i
    where i.tenant_id = new.tenant_id
      and i.kind = 'destination'
      and i.id::text = new.branding #>> '{home,hero,destinationId}'
  ) then
    raise exception 'the cover is not a destination of this tenant' using errcode = '23514', hint = 'home';
  end if;
  return new;
end;
$$;

revoke all on function private.home_destination_of_tenant() from public;

create trigger tenant_config_versions_home_destination
  before insert or update of branding on public.tenant_config_versions
  for each row execute function private.home_destination_of_tenant();
