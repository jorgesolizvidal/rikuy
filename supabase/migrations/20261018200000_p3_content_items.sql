-- ─────────────────────────────────────────────────────────────────────────────
-- P3 · Paso 2: editorial content (destinations) with revisions, location and images.
--
--   * content_items: stable identity (kind + slug per tenant) and two pointers: the one
--     open draft and the published (sealed) revision. The public only ever reads the
--     revision the published pointer names.
--   * content_revisions: numbered snapshots. A draft is edited in place with optimistic
--     concurrency (edit_count); publishing seals it (immutable from then on). Rolling
--     back = pointing the published pointer at an older sealed revision.
--   * Location: latitude/longitude columns plus a generated PostGIS geography point
--     (GiST index) for distance and area queries (ADR-021).
--   * Body: rich text as an allow-listed AST (no HTML), validated here and in @rikuy/core.
--   * media_references: cover and gallery images of a revision, by asset version, with
--     mandatory alternative text. Publishing requires their public derivatives.
-- Writes only through intent RPCs. Expand-only.
-- Error codes: 42501 forbidden · 23514 invalid · PT404 unknown · PT409 conflict/state.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists postgis with schema extensions;

create type public.content_kind as enum ('destination');
create type public.media_reference_purpose as enum ('cover', 'gallery');

-- ── Tables ──────────────────────────────────────────────────────────────────

create table public.content_items (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete restrict,
  kind                  public.content_kind not null,
  slug                  text not null,
  draft_revision_id     uuid,
  published_revision_id uuid,
  published_at          timestamptz,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint content_items_tenant_id_id_key unique (tenant_id, id),
  constraint content_items_tenant_kind_slug_key unique (tenant_id, kind, slug),
  constraint content_items_slug_format check (
    char_length(slug) between 1 and 80 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint content_items_published_has_timestamp check (
    (published_revision_id is null) = (published_at is null)
  )
);

create table public.content_revisions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  content_id  uuid not null,
  revision_no integer not null,
  state       public.config_state not null default 'draft',
  edit_count  integer not null default 1,
  title       text not null,
  summary     text not null default '',
  body        jsonb not null default '[]'::jsonb,
  latitude    double precision,
  longitude   double precision,
  location    extensions.geography(Point, 4326) generated always as (
    case when latitude is not null and longitude is not null
      then extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)::extensions.geography
    end
  ) stored,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  sealed_by   uuid references auth.users (id) on delete set null,
  sealed_at   timestamptz,

  constraint content_revisions_tenant_id_id_key unique (tenant_id, id),
  constraint content_revisions_content_id_id_key unique (content_id, id),
  constraint content_revisions_content_no_key unique (tenant_id, content_id, revision_no),
  constraint content_revisions_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete restrict,
  constraint content_revisions_revision_positive check (revision_no >= 1),
  constraint content_revisions_edit_positive check (edit_count >= 1),
  constraint content_revisions_sealed_has_timestamp check ((state = 'sealed') = (sealed_at is not null)),
  constraint content_revisions_title check (
    char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]' and title = btrim(title)
  ),
  constraint content_revisions_summary check (
    char_length(summary) <= 300 and summary !~ '[[:cntrl:]]' and summary = btrim(summary)
  ),
  constraint content_revisions_body_array check (jsonb_typeof(body) = 'array'),
  constraint content_revisions_coordinates check (
    (latitude is null) = (longitude is null)
    and (latitude is null or (latitude between -90 and 90 and longitude between -180 and 180))
  )
);

-- One open draft per content item.
create unique index content_revisions_one_draft_idx
  on public.content_revisions (content_id)
  where state = 'draft';
create index content_revisions_location_idx on public.content_revisions using gist (location);

-- Pointers name revisions of the SAME item (and therefore the same tenant).
alter table public.content_items
  add constraint content_items_draft_fkey
    foreign key (id, draft_revision_id) references public.content_revisions (content_id, id)
    deferrable initially deferred,
  add constraint content_items_published_fkey
    foreign key (id, published_revision_id) references public.content_revisions (content_id, id)
    deferrable initially deferred;

create table public.media_references (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  revision_id      uuid not null,
  asset_version_id uuid not null,
  purpose          public.media_reference_purpose not null,
  position         smallint not null default 0,
  alt_text         text not null,

  constraint media_references_revision_fkey foreign key (tenant_id, revision_id)
    references public.content_revisions (tenant_id, id) on delete cascade,
  constraint media_references_asset_version_fkey foreign key (tenant_id, asset_version_id)
    references public.asset_versions (tenant_id, id) on delete restrict,
  constraint media_references_slot_key unique (revision_id, purpose, position),
  constraint media_references_position check (
    position between 0 and 29 and (purpose <> 'cover' or position = 0)
  ),
  constraint media_references_alt_text check (
    char_length(alt_text) between 1 and 200 and alt_text !~ '[[:cntrl:]]' and alt_text = btrim(alt_text)
  )
);

create index media_references_asset_version_idx on public.media_references (tenant_id, asset_version_id);

-- ── Integrity triggers ─────────────────────────────────────────────────────

-- Sealed revisions (and their images) are immutable and cannot be deleted.
create function private.protect_sealed_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state = 'sealed' then
    raise exception 'sealed revisions are immutable' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger content_revisions_protect_sealed
  before update or delete on public.content_revisions
  for each row execute function private.protect_sealed_revision();

create function private.protect_sealed_media_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision uuid := case when tg_op = 'INSERT' then new.revision_id else old.revision_id end;
begin
  if exists (select 1 from public.content_revisions r where r.id = v_revision and r.state = 'sealed') then
    raise exception 'images of a sealed revision are immutable' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.protect_sealed_media_reference() from public;

create trigger media_references_protect_sealed
  before insert or update or delete on public.media_references
  for each row execute function private.protect_sealed_media_reference();

create trigger content_items_forbid_tenant_change
  before update of tenant_id on public.content_items
  for each row execute function private.forbid_tenant_change();
create trigger content_revisions_forbid_tenant_change
  before update of tenant_id on public.content_revisions
  for each row execute function private.forbid_tenant_change();

-- ── Privileges and RLS (read for members; writes only through RPCs) ────────

revoke all on table public.content_items, public.content_revisions, public.media_references
  from anon, authenticated;
grant select on table public.content_items, public.content_revisions, public.media_references
  to authenticated;

alter table public.content_items enable row level security;
alter table public.content_revisions enable row level security;
alter table public.media_references enable row level security;

create policy content_items_select_members
  on public.content_items for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));
create policy content_revisions_select_members
  on public.content_revisions for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));
create policy media_references_select_members
  on public.media_references for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));

-- ── Validation (mirror of @rikuy/core richText and destinationDraft) ───────

-- A text run or link inside a block. Links: https only, no userinfo, no whitespace.
create function private.is_valid_inline(p jsonb, p_allow_link boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_child jsonb;
  v_marks jsonb;
begin
  if jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if p ->> 'type' = 'text' then
    if not (
      private.has_exact_keys(p, array['type', 'text'], array['marks'])
      and jsonb_typeof(p -> 'text') = 'string'
      and char_length(p ->> 'text') between 1 and 5000
      and (p ->> 'text') !~ '[[:cntrl:]]'
    ) then
      return false;
    end if;
    if p ? 'marks' then
      v_marks := p -> 'marks';
      if jsonb_typeof(v_marks) <> 'array' or jsonb_array_length(v_marks) not between 1 and 2 then
        return false;
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_marks) m
        where jsonb_typeof(m.value) <> 'string' or m.value #>> '{}' not in ('bold', 'italic')
      ) or (select count(distinct m.value) from jsonb_array_elements(v_marks) m) <> jsonb_array_length(v_marks) then
        return false;
      end if;
    end if;
    return true;
  end if;
  if p ->> 'type' = 'link' and p_allow_link then
    if not (
      private.has_exact_keys(p, array['type', 'href', 'children'])
      and private.is_plain_line(p -> 'href', 9, 2000)
      and (p ->> 'href') ~ '^https://[^/@?#[:space:]]+([/?#][^[:space:]]*)?$'
      and jsonb_typeof(p -> 'children') = 'array'
      and jsonb_array_length(p -> 'children') between 1 and 20
    ) then
      return false;
    end if;
    for v_child in select value from jsonb_array_elements(p -> 'children') loop
      if not private.is_valid_inline(v_child, false) or v_child ->> 'type' <> 'text' then
        return false;
      end if;
    end loop;
    return true;
  end if;
  return false;
end;
$$;

create function private.is_valid_inlines(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'array'
    and jsonb_array_length(p) between 1 and 200
    and not exists (
      select 1 from jsonb_array_elements(p) e where not private.is_valid_inline(e.value, true)
    ),
    false
  );
$$;

-- Body: up to 200 blocks of paragraph / heading (2–3) / list; at most ~100 KB.
create function private.is_valid_rich_text(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_block jsonb;
  v_item jsonb;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 200 or octet_length(p::text) > 100000 then
    return false;
  end if;
  for v_block in select value from jsonb_array_elements(p) loop
    case v_block ->> 'type'
      when 'paragraph' then
        if not (
          private.has_exact_keys(v_block, array['type', 'children'])
          and private.is_valid_inlines(v_block -> 'children')
        ) then
          return false;
        end if;
      when 'heading' then
        if not (
          private.has_exact_keys(v_block, array['type', 'level', 'children'])
          and jsonb_typeof(v_block -> 'level') = 'number'
          and coalesce(v_block ->> 'level' in ('2', '3'), false)
          and private.is_valid_inlines(v_block -> 'children')
        ) then
          return false;
        end if;
      when 'list' then
        if not (
          private.has_exact_keys(v_block, array['type', 'ordered', 'items'])
          and jsonb_typeof(v_block -> 'ordered') = 'boolean'
          and jsonb_typeof(v_block -> 'items') = 'array'
          and jsonb_array_length(v_block -> 'items') between 1 and 100
        ) then
          return false;
        end if;
        for v_item in select value from jsonb_array_elements(v_block -> 'items') loop
          if not private.is_valid_inlines(v_item) then
            return false;
          end if;
        end loop;
      else
        return false;
    end case;
  end loop;
  return true;
end;
$$;

-- An image reference: {assetId, version, alt}.
create function private.is_valid_image_reference(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    private.has_exact_keys(p, array['assetId', 'version', 'alt'])
    and jsonb_typeof(p -> 'assetId') = 'string'
    and (p ->> 'assetId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(p -> 'version') = 'number'
    and (p ->> 'version') ~ '^[1-9][0-9]{0,5}$'
    and private.is_plain_line(p -> 'alt', 1, 200),
    false
  );
$$;

-- Destination draft: {title, summary, body, location|null, cover|null, gallery[]}.
create function private.is_valid_destination_draft(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_image jsonb;
begin
  if not (
    private.has_exact_keys(p, array['title', 'summary', 'body', 'location', 'cover', 'gallery'])
    and private.is_plain_line(p -> 'title', 1, 120)
    and private.is_plain_line(p -> 'summary', 0, 300)
    and private.is_valid_rich_text(p -> 'body')
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

revoke all on function private.is_valid_inline(jsonb, boolean) from public;
revoke all on function private.is_valid_inlines(jsonb) from public;
revoke all on function private.is_valid_rich_text(jsonb) from public;
revoke all on function private.is_valid_image_reference(jsonb) from public;
revoke all on function private.is_valid_destination_draft(jsonb) from public;

-- Asset version id of a content image of this tenant; ready (and published if required).
create function private.content_image_version(
  p_tenant_id uuid,
  p_reference jsonb,
  p_require_published boolean
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select v.id into v_id
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
  where v.tenant_id = p_tenant_id
    and a.purpose = 'content'
    and v.asset_id = (p_reference ->> 'assetId')::uuid
    and v.version = (p_reference ->> 'version')::integer
    and v.status = 'ready'
    and (not p_require_published or v.published_at is not null);
  if v_id is null then
    raise exception 'an image is not available for this tenant'
      using errcode = case when p_require_published then 'PT409' else '23514' end, hint = 'media';
  end if;
  return v_id;
end;
$$;

revoke all on function private.content_image_version(uuid, jsonb, boolean) from public;

-- Invoker rights: called only from the definer RPCs below.
create function private.assert_content_role(p_tenant_id uuid, p_roles public.membership_role[])
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, p_roles)
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to manage the content of this tenant' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.assert_content_role(uuid, public.membership_role[]) from public;

-- The draft as the editor knows it (used to build the editor and to republish).
create function private.revision_document(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
  )
  from public.content_revisions r
  where r.id = p_revision_id;
$$;

revoke all on function private.revision_document(uuid) from public;

-- ── Intent RPCs ─────────────────────────────────────────────────────────────

-- Owners, admins and editors create a destination: identity + first draft.
create function public.create_content_item(
  p_tenant_id uuid,
  p_kind public.content_kind,
  p_slug text,
  p_title text
)
returns table (content_id uuid, revision_id uuid, edit_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  if p_slug is null or char_length(p_slug) not between 1 and 80 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or not private.is_plain_line(to_jsonb(p_title), 1, 120) then
    raise exception 'invalid identifier or title' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.content_items i
    where i.tenant_id = p_tenant_id and i.kind = p_kind and i.slug = p_slug
  ) then
    raise exception 'this identifier is already used' using errcode = 'PT409', hint = 'slug';
  end if;

  insert into public.content_items (id, tenant_id, kind, slug, created_by)
  values (v_item, p_tenant_id, p_kind, p_slug, (select auth.uid()));

  insert into public.content_revisions (id, tenant_id, content_id, revision_no, title, created_by, updated_by)
  values (v_revision, p_tenant_id, v_item, 1, p_title, (select auth.uid()), (select auth.uid()));

  update public.content_items i set draft_revision_id = v_revision where i.id = v_item;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'content.created', 'content_item', v_item, 1, 'success',
          jsonb_build_object('kind', p_kind, 'slug', p_slug));

  return query select v_item, v_revision, 1;
exception when unique_violation then
  raise exception 'this identifier is already used' using errcode = 'PT409', hint = 'slug';
end;
$$;

-- Saves the full draft document. Opens a new draft if the item has none (expected
-- edit must then be null); otherwise the caller's edit_count must match.
create function public.save_content_draft(
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
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;

  if p_document is null or not private.is_valid_destination_draft(p_document) then
    raise exception 'invalid destination' using errcode = '23514';
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

-- Owners and admins publish the open draft: seal it and point the public at it.
create function public.publish_content(
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

  -- A published destination needs a summary and a location.
  if v_draft.summary = '' or v_draft.latitude is null then
    raise exception 'a destination needs a summary and a location to be published'
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
          jsonb_build_object('revision_id', v_draft.id, 'previous_revision_id', v_item.published_revision_id));

  return query select v_draft.id, v_draft.revision_no;
end;
$$;

-- Owners and admins put an earlier sealed revision back in front of the public.
create function public.restore_content_revision(
  p_tenant_id uuid,
  p_content_id uuid,
  p_revision_id uuid
)
returns table (revision_id uuid, revision_no integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item public.content_items%rowtype;
  v_revision public.content_revisions%rowtype;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;

  select r.* into v_revision
  from public.content_revisions r
  where r.id = p_revision_id and r.content_id = p_content_id and r.state = 'sealed';
  if not found then
    raise exception 'only published revisions of this content can be restored' using errcode = 'PT404';
  end if;
  if v_item.published_revision_id = p_revision_id then
    raise exception 'this revision is already the published one' using errcode = 'PT409';
  end if;

  update public.content_items i
  set published_revision_id = p_revision_id, published_at = now(), updated_at = now()
  where i.id = p_content_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'content.restored', 'content_item', p_content_id,
          v_revision.revision_no, 'success',
          jsonb_build_object('revision_id', p_revision_id, 'previous_revision_id', v_item.published_revision_id));

  return query select v_revision.id, v_revision.revision_no;
end;
$$;

-- Discards the open draft of an item that is already published.
create function public.discard_content_draft(
  p_tenant_id uuid,
  p_content_id uuid,
  p_expected_edit integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.content_items%rowtype;
  v_draft public.content_revisions%rowtype;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;
  if v_item.draft_revision_id is null then
    raise exception 'there is no draft to discard' using errcode = 'PT409';
  end if;
  if v_item.published_revision_id is null then
    raise exception 'a content that was never published keeps its draft'
      using errcode = 'PT409', hint = 'never_published';
  end if;

  select r.* into v_draft from public.content_revisions r where r.id = v_item.draft_revision_id for update;
  if v_draft.edit_count is distinct from p_expected_edit then
    raise exception 'the draft changed meanwhile' using errcode = 'PT409';
  end if;

  update public.content_items i set draft_revision_id = null, updated_at = now() where i.id = p_content_id;
  delete from public.content_revisions r where r.id = v_draft.id;
end;
$$;

-- ── Anonymous reads for portals (published revisions of active tenants) ────

create function public.list_published_destinations(p_tenant_id uuid)
returns table (
  content_id uuid,
  slug text,
  revision_no integer,
  title text,
  summary text,
  latitude double precision,
  longitude double precision,
  cover jsonb,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.slug, r.revision_no, r.title, r.summary, r.latitude, r.longitude,
         private.revision_document(r.id) -> 'cover', i.published_at
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.content_id = i.id and r.id = i.published_revision_id
  where i.tenant_id = p_tenant_id
    and i.kind = 'destination'
    and r.state = 'sealed'
  order by r.title;
$$;

create function public.get_published_destination(p_tenant_id uuid, p_slug text)
returns table (
  content_id uuid,
  slug text,
  revision_no integer,
  document jsonb,
  published_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.slug, r.revision_no, private.revision_document(r.id), i.published_at, r.sealed_at
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.content_id = i.id and r.id = i.published_revision_id
  where i.tenant_id = p_tenant_id
    and i.kind = 'destination'
    and i.slug = p_slug
    and r.state = 'sealed';
$$;

-- Members: the editor's view of one revision (draft or any sealed one of their tenant).
create function public.content_revision_document(p_tenant_id uuid, p_revision_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[])
     or not exists (select 1 from public.content_revisions r where r.id = p_revision_id and r.tenant_id = p_tenant_id) then
    raise exception 'revision not found' using errcode = 'PT404';
  end if;
  return private.revision_document(p_revision_id);
end;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

revoke all on function public.create_content_item(uuid, public.content_kind, text, text) from public, anon, authenticated;
revoke all on function public.save_content_draft(uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.publish_content(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.restore_content_revision(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.discard_content_draft(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.list_published_destinations(uuid) from public, anon, authenticated;
revoke all on function public.get_published_destination(uuid, text) from public, anon, authenticated;
revoke all on function public.content_revision_document(uuid, uuid) from public, anon, authenticated;

grant execute on function public.create_content_item(uuid, public.content_kind, text, text) to authenticated;
grant execute on function public.save_content_draft(uuid, uuid, jsonb, integer) to authenticated;
grant execute on function public.publish_content(uuid, uuid, integer) to authenticated;
grant execute on function public.restore_content_revision(uuid, uuid, uuid) to authenticated;
grant execute on function public.discard_content_draft(uuid, uuid, integer) to authenticated;
grant execute on function public.list_published_destinations(uuid) to anon, authenticated;
grant execute on function public.get_published_destination(uuid, text) to anon, authenticated;
grant execute on function public.content_revision_document(uuid, uuid) to authenticated;
