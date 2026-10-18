-- ─────────────────────────────────────────────────────────────────────────────
-- P3 · Paso 3: public destination pages.
--
--   * portal_destinations / portal_destination: what a portal renders, with the pixel
--     size of every image so pages reserve their space (no layout shift). Published
--     revisions of ACTIVE tenants only; drafts never leave the database.
--   * tenant_portal_host: the canonical portal hostname for any active member (it is
--     public information) — used by the admin to link and print QR codes.
-- The P3 · Paso 2 reads stay as they are (expand-only).
-- ─────────────────────────────────────────────────────────────────────────────

-- One published image: {assetId, version, alt, width, height} of the original.
create function private.public_image(p_asset_version_id uuid, p_alt text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'assetId', v.asset_id, 'version', v.version, 'alt', p_alt,
    'width', v.width, 'height', v.height
  )
  from public.asset_versions v
  where v.id = p_asset_version_id and v.status = 'ready' and v.published_at is not null;
$$;

revoke all on function private.public_image(uuid, text) from public;

create function public.portal_destinations(p_tenant_id uuid)
returns table (
  slug text,
  title text,
  summary text,
  latitude double precision,
  longitude double precision,
  cover jsonb,
  published_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.slug, r.title, r.summary, r.latitude, r.longitude,
         (select private.public_image(m.asset_version_id, m.alt_text)
          from public.media_references m
          where m.revision_id = r.id and m.purpose = 'cover'),
         i.published_at, r.sealed_at
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  where i.tenant_id = p_tenant_id
    and i.kind = 'destination'
    and r.state = 'sealed'
  order by r.title;
$$;

create function public.portal_destination(p_tenant_id uuid, p_slug text)
returns table (
  slug text,
  revision_no integer,
  title text,
  summary text,
  body jsonb,
  latitude double precision,
  longitude double precision,
  cover jsonb,
  gallery jsonb,
  published_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.slug, r.revision_no, r.title, r.summary, r.body, r.latitude, r.longitude,
         (select private.public_image(m.asset_version_id, m.alt_text)
          from public.media_references m
          where m.revision_id = r.id and m.purpose = 'cover'),
         coalesce((select jsonb_agg(private.public_image(m.asset_version_id, m.alt_text) order by m.position)
                   from public.media_references m
                   where m.revision_id = r.id and m.purpose = 'gallery'), '[]'::jsonb),
         i.published_at, r.sealed_at
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id
  where i.tenant_id = p_tenant_id
    and i.kind = 'destination'
    and i.slug = p_slug
    and r.state = 'sealed';
$$;

-- Canonical portal hostname of a tenant, for any active member (public information).
create function public.tenant_portal_host(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.hostname
  from public.tenants t
  join public.tenant_domains d on d.id = t.canonical_domain_id and d.tenant_id = t.id
  where t.id = p_tenant_id
    and d.status = 'active'
    and private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]);
$$;

revoke all on function public.portal_destinations(uuid) from public, anon, authenticated;
revoke all on function public.portal_destination(uuid, text) from public, anon, authenticated;
revoke all on function public.tenant_portal_host(uuid) from public, anon, authenticated;

grant execute on function public.portal_destinations(uuid) to anon, authenticated;
grant execute on function public.portal_destination(uuid, text) to anon, authenticated;
grant execute on function public.tenant_portal_host(uuid) to authenticated;
