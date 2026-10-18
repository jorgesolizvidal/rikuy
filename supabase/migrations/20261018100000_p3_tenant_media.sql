-- ─────────────────────────────────────────────────────────────────────────────
-- P3 · Paso 1: tenant media (images) and the municipality logo.
--
--   * Buckets per environment: media-originals (private, what people upload) and
--     media-public (only derivatives of PUBLISHED images, served by the CDN).
--   * Object paths: {tenant_id}/{asset_id}/{version}/{file} — never a municipality name.
--   * People only ever write ONE thing: the original, at the exact path of an image
--     version they are allowed to upload ('uploading'). Validation, derivatives, the
--     'ready' state and publication are done by the server's isolated media adapter
--     (service role). Nobody else writes derivatives or the public bucket.
--   * The brand references its logo by {assetId, version}; saving requires a ready logo
--     of the same tenant, publishing requires its public derivatives to exist.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.asset_purpose as enum ('logo', 'content');
create type public.asset_version_status as enum ('uploading', 'ready', 'rejected');

create table public.assets (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  purpose    public.asset_purpose not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint assets_tenant_id_id_key unique (tenant_id, id)
);

create table public.asset_versions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  asset_id        uuid not null,
  version         integer not null default 1,
  status          public.asset_version_status not null default 'uploading',
  declared_mime   text not null,
  declared_bytes  integer not null,
  original_path   text generated always as (
    tenant_id::text || '/' || asset_id::text || '/' || version::text || '/original'
  ) stored,
  mime            text,
  bytes           integer,
  width           integer,
  height          integer,
  sha256          text,
  rejected_reason text,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  ready_at        timestamptz,
  published_at    timestamptz,

  constraint asset_versions_tenant_id_id_key unique (tenant_id, id),
  constraint asset_versions_asset_version_key unique (asset_id, version),
  constraint asset_versions_original_path_key unique (original_path),
  constraint asset_versions_asset_fkey foreign key (tenant_id, asset_id)
    references public.assets (tenant_id, id) on delete restrict,
  constraint asset_versions_version_positive check (version >= 1),
  constraint asset_versions_declared_mime check (declared_mime in ('image/png', 'image/jpeg', 'image/webp')),
  constraint asset_versions_declared_bytes check (declared_bytes between 1 and 10485760),
  constraint asset_versions_ready_has_metadata check (
    status <> 'ready' or (
      mime in ('image/png', 'image/jpeg', 'image/webp') and bytes > 0 and width > 0 and height > 0
      and sha256 ~ '^[0-9a-f]{64}$' and ready_at is not null
    )
  ),
  constraint asset_versions_rejected_has_reason check (
    status <> 'rejected' or char_length(coalesce(rejected_reason, '')) between 1 and 200
  ),
  constraint asset_versions_published_is_ready check (published_at is null or status = 'ready')
);

create index asset_versions_tenant_status_idx on public.asset_versions (tenant_id, status, created_at);

create trigger assets_forbid_tenant_change
  before update of tenant_id on public.assets
  for each row execute function private.forbid_tenant_change();
create trigger asset_versions_forbid_tenant_change
  before update of tenant_id on public.asset_versions
  for each row execute function private.forbid_tenant_change();

revoke all on table public.assets, public.asset_versions from anon, authenticated;
grant select on table public.assets, public.asset_versions to authenticated;

alter table public.assets enable row level security;
alter table public.asset_versions enable row level security;

create policy assets_select_members
  on public.assets for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));
create policy asset_versions_select_members
  on public.asset_versions for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));

-- ── Buckets ─────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('media-originals', 'media-originals', false, 10485760, array['image/png', 'image/jpeg', 'image/webp']),
  ('media-public', 'media-public', true, 5242880, array['image/webp', 'image/png'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ── Storage policies (storage.objects already has RLS enabled) ─────────────

-- Tenant id of an object path, or null when the first segment is not a uuid.
create function private.storage_path_tenant(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(p_name, '/', 1)::uuid
  end;
$$;

-- True only for the exact original path of a version in 'uploading' that the caller
-- may upload: logos by owners/admins, content images also by editors.
create function private.can_upload_original(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.asset_versions v
    join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
    where v.original_path = p_name
      and v.status = 'uploading'
      and private.has_tenant_role(
        v.tenant_id,
        case when a.purpose = 'logo'
          then array['owner', 'admin']::public.membership_role[]
          else array['owner', 'admin', 'editor']::public.membership_role[]
        end
      )
  );
$$;

revoke all on function private.storage_path_tenant(text) from public;
revoke all on function private.can_upload_original(text) from public;
grant execute on function private.storage_path_tenant(text) to authenticated;
grant execute on function private.can_upload_original(text) to authenticated;

create policy media_originals_insert_own_upload
  on storage.objects for insert to authenticated
  with check (bucket_id = 'media-originals' and private.can_upload_original(name));

create policy media_originals_select_members
  on storage.objects for select to authenticated
  using (
    bucket_id = 'media-originals'
    and private.has_tenant_role(
      private.storage_path_tenant(name),
      array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
    )
  );
-- No update/delete policies: originals are immutable for people; media-public is
-- written only by the service role and read through its public URL.

-- ── Upload lifecycle ────────────────────────────────────────────────────────
-- Error codes: 42501 forbidden · 23514 invalid · PT404 unknown · PT409 wrong state ·
-- PT429 too many pending uploads.

create function public.create_image_upload(
  p_tenant_id uuid,
  p_purpose public.asset_purpose,
  p_mime text,
  p_bytes integer
)
returns table (asset_id uuid, version_id uuid, version integer, original_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_asset uuid;
  v_version public.asset_versions%rowtype;
begin
  if not private.has_tenant_role(
       p_tenant_id,
       case when p_purpose = 'logo'
         then array['owner', 'admin']::public.membership_role[]
         else array['owner', 'admin', 'editor']::public.membership_role[]
       end)
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to upload images for this tenant' using errcode = '42501';
  end if;

  if (
    select count(*) from public.asset_versions v
    where v.tenant_id = p_tenant_id and v.status = 'uploading' and v.created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'too many pending uploads' using errcode = 'PT429';
  end if;

  insert into public.assets (tenant_id, purpose, created_by)
  values (p_tenant_id, p_purpose, (select auth.uid()))
  returning id into v_asset;

  insert into public.asset_versions (tenant_id, asset_id, version, declared_mime, declared_bytes, created_by)
  values (p_tenant_id, v_asset, 1, p_mime, p_bytes, (select auth.uid()))
  returning * into v_version;

  return query select v_asset, v_version.id, v_version.version, v_version.original_path;
end;
$$;

-- Service role only: the media adapter validated the bytes and stored the derivatives.
create function public.media_complete_upload(
  p_version_id uuid,
  p_mime text,
  p_bytes integer,
  p_width integer,
  p_height integer,
  p_sha256 text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.asset_versions v
  set status = 'ready', mime = p_mime, bytes = p_bytes, width = p_width, height = p_height,
      sha256 = p_sha256, ready_at = now()
  where v.id = p_version_id and v.status = 'uploading';
  if not found then
    raise exception 'version is not uploading' using errcode = 'PT409';
  end if;
end;
$$;

create function public.media_reject_upload(p_version_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.asset_versions v
  set status = 'rejected', rejected_reason = left(p_reason, 200)
  where v.id = p_version_id and v.status = 'uploading';
  if not found then
    raise exception 'version is not uploading' using errcode = 'PT409';
  end if;
end;
$$;

-- Marks a ready version as published (its derivatives are now in media-public).
create function public.media_publish_version(p_tenant_id uuid, p_asset_id uuid, p_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.asset_version_status;
begin
  select v.status into v_status
  from public.asset_versions v
  where v.tenant_id = p_tenant_id and v.asset_id = p_asset_id and v.version = p_version
  for update;
  if not found then
    raise exception 'image version not found' using errcode = 'PT404';
  end if;
  if v_status <> 'ready' then
    raise exception 'only ready images can be published' using errcode = 'PT409';
  end if;
  update public.asset_versions v
  set published_at = coalesce(v.published_at, now())
  where v.tenant_id = p_tenant_id and v.asset_id = p_asset_id and v.version = p_version;
end;
$$;

-- ── Logo in the brand ───────────────────────────────────────────────────────

-- The brand may reference a logo only if it is a ready logo of the same tenant; to be
-- published, its public derivatives must exist (published_at set).
create function private.assert_logo_reference(p_tenant_id uuid, p_branding jsonb, p_require_published boolean)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (p_branding ? 'logo') then
    return;
  end if;
  if not exists (
    select 1
    from public.asset_versions v
    join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
    where v.tenant_id = p_tenant_id
      and a.purpose = 'logo'
      and v.asset_id = (p_branding #>> '{logo,assetId}')::uuid
      and v.version = (p_branding #>> '{logo,version}')::integer
      and v.status = 'ready'
      and (not p_require_published or v.published_at is not null)
  ) then
    raise exception 'the logo is not an available image of this tenant'
      using errcode = case when p_require_published then 'PT409' else '23514' end, hint = 'logo';
  end if;
end;
$$;

revoke all on function private.assert_logo_reference(uuid, jsonb, boolean) from public;

-- Presentation contract: optional logo reference (mirror of tenantPresentationSchema).
create or replace function private.is_valid_presentation(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if not private.has_exact_keys(p, array['identity', 'theme', 'contact', 'social', 'seo'], array['logo']) then
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

  -- identity
  if not (
    private.has_exact_keys(p -> 'identity', array['siteName', 'shortName', 'tagline'])
    and private.is_plain_line(p #> '{identity,siteName}', 1, 60)
    and private.is_plain_line(p #> '{identity,shortName}', 1, 12)
    and private.is_plain_line(p #> '{identity,tagline}', 0, 140)
  ) then
    return false;
  end if;

  -- theme: colors are lowercase #rrggbb, so they are safe inside CSS
  if not (
    private.has_exact_keys(p -> 'theme', array['mode', 'brand', 'accent'])
    and coalesce(p #>> '{theme,mode}' in ('light', 'dark'), false)
    and coalesce((p #>> '{theme,brand}') ~ '^#[0-9a-f]{6}$', false)
    and coalesce((p #>> '{theme,accent}') ~ '^#[0-9a-f]{6}$', false)
    and jsonb_typeof(p #> '{theme,brand}') = 'string'
    and jsonb_typeof(p #> '{theme,accent}') = 'string'
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

-- Same RPCs as P1 · Paso 5, now checking the logo reference.
create or replace function public.save_tenant_config_draft(
  p_tenant_id uuid,
  p_branding jsonb,
  p_expected_revision integer
)
returns table (config_id uuid, version integer, revision integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft public.tenant_config_versions%rowtype;
begin
  perform private.assert_can_manage_config(p_tenant_id);

  if p_branding is null or not private.is_valid_presentation(p_branding) then
    raise exception 'invalid presentation' using errcode = '23514';
  end if;
  perform private.assert_logo_reference(p_tenant_id, p_branding, false);

  select c.* into v_draft
  from public.tenant_config_versions c
  where c.tenant_id = p_tenant_id and c.state = 'draft'
  for update;

  if not found then
    if p_expected_revision is not null then
      raise exception 'the draft was published or discarded meanwhile' using errcode = 'PT409';
    end if;
    begin
      insert into public.tenant_config_versions
        (tenant_id, version, schema_version, branding, state, created_by, updated_by)
      values (
        p_tenant_id,
        (select coalesce(max(c.version), 0) + 1 from public.tenant_config_versions c where c.tenant_id = p_tenant_id),
        1,
        p_branding,
        'draft',
        (select auth.uid()),
        (select auth.uid())
      )
      returning * into v_draft;
    exception when unique_violation then
      raise exception 'another draft was created meanwhile' using errcode = 'PT409';
    end;
  else
    if p_expected_revision is distinct from v_draft.revision then
      raise exception 'the draft changed meanwhile' using errcode = 'PT409';
    end if;
    update public.tenant_config_versions c
    set branding = p_branding,
        revision = c.revision + 1,
        updated_by = (select auth.uid())
    where c.id = v_draft.id
    returning * into v_draft;
  end if;

  return query select v_draft.id, v_draft.version, v_draft.revision;
end;
$$;

create or replace function public.publish_tenant_config(
  p_tenant_id uuid,
  p_config_id uuid,
  p_expected_revision integer
)
returns table (config_id uuid, version integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft public.tenant_config_versions%rowtype;
  v_previous uuid;
begin
  perform private.assert_can_manage_config(p_tenant_id);

  -- Lock the tenant first: concurrent publications of one tenant are serialized.
  select t.active_config_id into v_previous
  from public.tenants t
  where t.id = p_tenant_id
  for update;

  select c.* into v_draft
  from public.tenant_config_versions c
  where c.id = p_config_id and c.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'configuration version not found' using errcode = 'PT404';
  end if;
  if v_draft.state <> 'draft' or v_draft.revision is distinct from p_expected_revision then
    raise exception 'the draft changed or was already published' using errcode = 'PT409';
  end if;
  if not private.is_valid_presentation(v_draft.branding) then
    raise exception 'an empty or invalid presentation cannot be published' using errcode = '23514';
  end if;
  -- The logo's public derivatives must exist before the portal can point at them.
  perform private.assert_logo_reference(p_tenant_id, v_draft.branding, true);

  update public.tenant_config_versions c
  set state = 'sealed', sealed_at = now(), updated_by = (select auth.uid())
  where c.id = v_draft.id;

  update public.tenants t
  set active_config_id = v_draft.id
  where t.id = p_tenant_id;

  insert into public.audit_events
    (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values (
    'tenant', p_tenant_id, (select auth.uid()), 'tenant.config.published',
    'tenant_config_version', v_draft.id, v_draft.version, 'success',
    jsonb_build_object('version', v_draft.version, 'previous_config_id', v_previous)
  );

  return query select v_draft.id, v_draft.version;
end;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

revoke all on function public.create_image_upload(uuid, public.asset_purpose, text, integer) from public, anon, authenticated;
revoke all on function public.media_complete_upload(uuid, text, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.media_reject_upload(uuid, text) from public, anon, authenticated;
revoke all on function public.media_publish_version(uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.create_image_upload(uuid, public.asset_purpose, text, integer) to authenticated;
grant execute on function public.media_complete_upload(uuid, text, integer, integer, integer, text) to service_role;
grant execute on function public.media_reject_upload(uuid, text) to service_role;
grant execute on function public.media_publish_version(uuid, uuid, integer) to service_role;
