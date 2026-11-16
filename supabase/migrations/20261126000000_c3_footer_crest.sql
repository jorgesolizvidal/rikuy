-- Interface details (fix/interface-details, ADR-068): the municipality's coat of arms in the
-- portal's footer. Expand only.
--
--   * The brand accepts an optional `crest`: a reference {assetId, version} to an image of
--     the same tenant, exactly like the logo (same upload, same derivatives, same rules).
--   * Saving needs a ready image of this tenant; publishing needs its public derivatives
--     (the same check as the logo, now for both references).
--   * The daily sweep of unused images (ADR-035) counts a crest used by any brand version.

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
  if not private.has_exact_keys(p, array['identity', 'theme', 'contact', 'social', 'seo'], array['logo', 'crest', 'visitors', 'assistant', 'home']) then
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

  -- crest (optional, fix/interface-details): the municipality's coat of arms for the footer,
  -- an image reference like the logo, never a URL
  if p ? 'crest' and not (
    private.has_exact_keys(p -> 'crest', array['assetId', 'version'])
    and jsonb_typeof(p #> '{crest,assetId}') = 'string'
    and coalesce((p #>> '{crest,assetId}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
    and jsonb_typeof(p #> '{crest,version}') = 'number'
    and coalesce((p #>> '{crest,version}') ~ '^[1-9][0-9]{0,5}$', false)
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

-- ── Logo and crest references ──────────────────────────────────────────────

-- The brand may reference a logo or a crest only if each is a ready logo-type image of the
-- same tenant; to be published, its public derivatives must exist (published_at set).
create or replace function private.assert_logo_reference(p_tenant_id uuid, p_branding jsonb, p_require_published boolean)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  foreach v_key in array array['logo', 'crest'] loop
    continue when not (p_branding ? v_key);
    if not exists (
      select 1
      from public.asset_versions v
      join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
      where v.tenant_id = p_tenant_id
        and a.purpose = 'logo'
        and v.asset_id = (p_branding -> v_key ->> 'assetId')::uuid
        and v.version = (p_branding -> v_key ->> 'version')::integer
        and v.status = 'ready'
        and (not p_require_published or v.published_at is not null)
    ) then
      raise exception 'the % is not an available image of this tenant', v_key
        using errcode = case when p_require_published then 'PT409' else '23514' end, hint = v_key;
    end if;
  end loop;
end;
$$;

revoke all on function private.assert_logo_reference(uuid, jsonb, boolean) from public;

-- ── Unused images (ADR-035) ───────────────────────────────────────────────

-- A photo or a logo nothing uses: no content revision (draft or sealed), no tour point and
-- no brand version (draft or sealed) references it as logo or crest, and it has been ready
-- for 7 days.
create or replace function private.is_unused_media(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.asset_versions v
    join public.assets a on a.id = v.asset_id and a.tenant_id = v.tenant_id
    where v.id = p_version_id
      and a.purpose in ('content', 'logo')
      and v.status = 'ready'
      and v.ready_at < now() - interval '7 days'
      and not exists (select 1 from public.media_references m where m.asset_version_id = v.id)
      and not exists (select 1 from public.tour_hotspot_images h where h.asset_version_id = v.id)
      and not exists (
        select 1 from public.tenant_config_versions c
        where c.tenant_id = v.tenant_id
          and (
            (c.branding #>> '{logo,assetId}' = v.asset_id::text
              and c.branding #>> '{logo,version}' = v.version::text)
            or (c.branding #>> '{crest,assetId}' = v.asset_id::text
              and c.branding #>> '{crest,version}' = v.version::text)
          )
      )
  );
$$;

revoke all on function private.is_unused_media(uuid) from public;
