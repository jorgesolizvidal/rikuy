-- P3 · Paso 6 — visitor location (ADR-021). Expand only.
--
-- The visitor's position never reaches the database: distances, sorting and «Estás cerca
-- de…» are computed in the browser. The only server-side piece is the municipality's
-- «Estás cerca de…» radius, an optional part of the white-label presentation:
--   "visitors": { "nearbyRadius": 50..1000 }   (meters; absent → 150 m)

-- Presentation contract: optional logo and visitor settings (mirror of tenantPresentationSchema).
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
  if not private.has_exact_keys(p, array['identity', 'theme', 'contact', 'social', 'seo'], array['logo', 'visitors']) then
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

revoke all on function private.is_valid_presentation(jsonb) from public;
