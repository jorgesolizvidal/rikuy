-- ─────────────────────────────────────────────────────────────────────────────
-- P1 · Paso 5: white-label presentation (draft → sealed) per tenant.
--
--   * tenant_config_versions.branding holds a TenantPresentation (contract in
--     @rikuy/core). The database re-validates its shape so the write RPC cannot be
--     used to store arbitrary JSON, CSS or markup.
--   * At most one draft per tenant, edited with optimistic concurrency (revision).
--   * Writes go through two intent RPCs (owner/admin only):
--       save_tenant_config_draft  → create/update the draft
--       publish_tenant_config     → seal + move the active pointer + audit, one transaction
--   * get_published_presentation is the anonymous read: only the ACTIVE sealed version
--     of an ACTIVE tenant, never drafts or superseded versions.
-- Expand-only: no existing column, function or grant is removed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Columns for concurrency and authorship ──────────────────────────────────

alter table public.tenant_config_versions
  add column revision   integer not null default 1,
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references auth.users (id) on delete set null,
  add constraint tenant_config_versions_revision_positive check (revision >= 1);

create trigger tenant_config_versions_touch_updated_at
  before update on public.tenant_config_versions
  for each row execute function private.touch_updated_at();

-- At most one open draft per tenant.
create unique index tenant_config_versions_one_draft_idx
  on public.tenant_config_versions (tenant_id)
  where state = 'draft';

-- ── Shape validation (mirror of tenantPresentationSchema, schema_version 1) ──

-- One line of plain text: a JSON string without control characters or outer spaces.
create function private.is_plain_line(p_value jsonb, p_min integer, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p_value) = 'string'
    and char_length(p_value #>> '{}') between p_min and p_max
    and (p_value #>> '{}') !~ '[[:cntrl:]]'
    and (p_value #>> '{}') = btrim(p_value #>> '{}'),
    false
  );
$$;

-- True when the object has exactly `p_required` keys plus any subset of `p_optional`.
create function private.has_exact_keys(p_object jsonb, p_required text[], p_optional text[] default '{}')
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p_object) = 'object'
    and p_object ?& p_required
    and not exists (
      select 1 from jsonb_object_keys(p_object) as k (key)
      where k.key <> all (p_required || p_optional)
    ),
    false
  );
$$;

create function private.is_valid_presentation(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if not private.has_exact_keys(p, array['identity', 'theme', 'contact', 'social', 'seo']) then
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

revoke all on function private.is_plain_line(jsonb, integer, integer) from public;
revoke all on function private.has_exact_keys(jsonb, text[], text[]) from public;
revoke all on function private.is_valid_presentation(jsonb) from public;

-- '{}' means "no presentation yet" (portal uses neutral defaults).
alter table public.tenant_config_versions
  add constraint tenant_config_versions_branding_valid
  check (schema_version <> 1 or branding = '{}'::jsonb or private.is_valid_presentation(branding));

-- ── Intent RPCs ─────────────────────────────────────────────────────────────
-- Error codes (PostgREST maps PTxxx to that HTTP status):
--   42501 forbidden · 23514 invalid presentation · PT409 concurrent change · PT404 unknown draft

-- Invoker rights: only ever called from the definer RPCs below, never exposed.
create function private.assert_can_manage_config(p_tenant_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[])
     or not exists (
       select 1 from public.tenants t
       where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to manage the configuration of this tenant'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.assert_can_manage_config(uuid) from public;

create function public.save_tenant_config_draft(
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

create function public.publish_tenant_config(
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

-- Anonymous read for portals: only the active sealed version of an active tenant.
create function public.get_published_presentation(p_config_id uuid)
returns table (schema_version integer, branding jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select c.schema_version, c.branding
  from public.tenant_config_versions c
  join public.tenants t on t.id = c.tenant_id and t.active_config_id = c.id
  where c.id = p_config_id
    and c.state = 'sealed'
    and t.status = 'active';
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by default:
-- revoke explicitly, then grant the minimum.
revoke all on function public.save_tenant_config_draft(uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.publish_tenant_config(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.get_published_presentation(uuid) from public, anon, authenticated;

grant execute on function public.save_tenant_config_draft(uuid, jsonb, integer) to authenticated;
grant execute on function public.publish_tenant_config(uuid, uuid, integer) to authenticated;
grant execute on function public.get_published_presentation(uuid) to anon, authenticated;
