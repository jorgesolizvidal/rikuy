-- A · Paso 2 — «Solo asistente» (ADR-071). Expand only.
--
-- 1. The public portal becomes a module («Portal público», `portal`), on for every existing
--    municipality. The map, the 360° tours and the passport need it; without it the proxy only
--    lets the assistant's pages through (/preguntar, /insertar), so a municipality with its own
--    website can have the assistant alone.
-- 2. Where a municipality's assistant may be embedded: up to 10 origins per municipality, which
--    only the platform operator (second factor) adds or removes. The host registry returns them,
--    so the proxy answers the embed page with `frame-ancestors` for them alone.
-- 3. «Página en la web del municipio»: an optional link per destination, event, notice, service
--    or story, on an authorized origin; owners and admins set it. The assistant's answers link
--    there when they are shown on that website, or when the municipality has no portal.
--
-- Error codes: 42501 forbidden · 23514 invalid (hint: origin | url) · PT404 not found ·
-- PT409 too many (hint: too_many).

-- ── 1. The portal is a module ───────────────────────────────────────────────

insert into public.platform_modules (key, position, requires) values ('portal', 0, null);
update public.platform_modules set requires = 'portal' where key in ('map', 'tours', 'passport');

-- Every municipality that exists keeps its portal.
insert into public.tenant_modules (tenant_id, module)
select t.id, 'portal' from public.tenants t
on conflict do nothing;

-- ── 2. Where the assistant may be embedded ─────────────────────────────────

-- An origin, never a path: https with a host name, or http on this machine (development and
-- tests). Lowercase, as the app normalizes it.
create function private.is_valid_embed_origin(p_origin text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_origin is not null
    and char_length(p_origin) <= 200
    and (
      p_origin ~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[0-9]{1,5})?$'
      or p_origin ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$'
    );
$$;

create table public.assistant_embed_origins (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  origin     text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  constraint assistant_embed_origins_pkey primary key (tenant_id, origin),
  constraint assistant_embed_origins_origin check (private.is_valid_embed_origin(origin))
);

comment on table public.assistant_embed_origins is
  'Websites where a municipality''s assistant may be embedded (ADR-071); only platform functions write it.';

alter table public.assistant_embed_origins enable row level security;
revoke all on public.assistant_embed_origins from public, anon, authenticated;

create function private.tenant_embed_origins(p_tenant_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(o.origin order by o.origin), '{}')
  from public.assistant_embed_origins o
  where o.tenant_id = p_tenant_id;
$$;

revoke all on function private.tenant_embed_origins(uuid) from public;

create function public.platform_embed_origins(p_tenant_id uuid)
returns table (origin text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  return query
  select o.origin, o.created_at
  from public.assistant_embed_origins o
  where o.tenant_id = p_tenant_id
  order by o.origin;
end;
$$;

revoke all on function public.platform_embed_origins(uuid) from public, anon, authenticated;
grant execute on function public.platform_embed_origins(uuid) to authenticated;

create function public.platform_add_embed_origin(p_tenant_id uuid, p_origin text)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_added integer;
begin
  perform private.assert_platform_actor();
  -- Locks the municipality: two operators adding at once count one after the other.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'tenant not found' using errcode = 'PT404', hint = 'tenant';
  end if;
  if not private.is_valid_embed_origin(p_origin) then
    raise exception 'invalid origin' using errcode = '23514', hint = 'origin';
  end if;
  if not exists (
       select 1 from public.assistant_embed_origins o
       where o.tenant_id = p_tenant_id and o.origin = p_origin
     )
     and (select count(*) from public.assistant_embed_origins o where o.tenant_id = p_tenant_id) >= 10
  then
    raise exception 'too many websites' using errcode = 'PT409', hint = 'too_many';
  end if;

  insert into public.assistant_embed_origins (tenant_id, origin, created_by)
  values (p_tenant_id, p_origin, (select auth.uid()))
  on conflict do nothing;
  get diagnostics v_added = row_count;

  if v_added > 0 then
    insert into public.audit_events (
      scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff
    )
    values (
      'tenant', p_tenant_id, (select auth.uid()), 'platform.embed_origin_added', 'tenant', p_tenant_id,
      'success', jsonb_build_object('origin', p_origin)
    );
  end if;
  return private.tenant_embed_origins(p_tenant_id);
end;
$$;

revoke all on function public.platform_add_embed_origin(uuid, text) from public, anon, authenticated;
grant execute on function public.platform_add_embed_origin(uuid, text) to authenticated;

create function public.platform_remove_embed_origin(p_tenant_id uuid, p_origin text)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer;
begin
  perform private.assert_platform_actor();
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'tenant not found' using errcode = 'PT404', hint = 'tenant';
  end if;

  delete from public.assistant_embed_origins o
  where o.tenant_id = p_tenant_id and o.origin = p_origin;
  get diagnostics v_removed = row_count;

  if v_removed > 0 then
    insert into public.audit_events (
      scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff
    )
    values (
      'tenant', p_tenant_id, (select auth.uid()), 'platform.embed_origin_removed', 'tenant', p_tenant_id,
      'success', jsonb_build_object('origin', p_origin)
    );
  end if;
  return private.tenant_embed_origins(p_tenant_id);
end;
$$;

revoke all on function public.platform_remove_embed_origin(uuid, text) from public, anon, authenticated;
grant execute on function public.platform_remove_embed_origin(uuid, text) to authenticated;

-- Any member sees where the assistant may be embedded (the panel shows the line to copy).
create function public.tenant_embed_origins(p_tenant_id uuid)
returns text[]
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
  return private.tenant_embed_origins(p_tenant_id);
end;
$$;

revoke all on function public.tenant_embed_origins(uuid) from public, anon, authenticated;
grant execute on function public.tenant_embed_origins(uuid) to authenticated;

-- ── 3. «Página en la web del municipio» ─────────────────────────────────────

-- The origin of a link, or null if it is not a plain web address (no spaces, no user name or
-- password, at most 500 characters, on https or on this machine).
create function private.web_link_origin(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_url is null or char_length(p_url) > 500 or p_url ~ '[[:space:][:cntrl:]]' then null
    else (
      select m[1]
      from regexp_match(
        p_url,
        '^(https://[a-z0-9.-]+(?::[0-9]{1,5})?|http://(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?)(?:[/?#].*)?$'
      ) m
      where private.is_valid_embed_origin(m[1])
    )
  end;
$$;

alter table public.content_items add column web_url text;
alter table public.content_items add constraint content_items_web_url
  check (web_url is null or private.web_link_origin(web_url) is not null);

comment on column public.content_items.web_url is
  'The page about this item on the municipality''s own website (ADR-071), on an authorized origin.';

create function public.content_web_link(p_tenant_id uuid, p_content_id uuid)
returns text
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
  return (
    select i.web_url from public.content_items i
    where i.tenant_id = p_tenant_id and i.id = p_content_id
  );
end;
$$;

revoke all on function public.content_web_link(uuid, uuid) from public, anon, authenticated;
grant execute on function public.content_web_link(uuid, uuid) to authenticated;

create function public.set_content_web_link(p_tenant_id uuid, p_content_id uuid, p_url text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.content_items%rowtype;
  v_origin text;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select * into v_item from public.content_items i
  where i.tenant_id = p_tenant_id and i.id = p_content_id
  for update;
  if not found or v_item.kind not in ('destination', 'event', 'notice', 'service', 'story') then
    raise exception 'content not found' using errcode = 'PT404';
  end if;

  if p_url is not null then
    v_origin := private.web_link_origin(p_url);
    if v_origin is null then
      raise exception 'invalid web address' using errcode = '23514', hint = 'url';
    end if;
    if not (v_origin = any (private.tenant_embed_origins(p_tenant_id))) then
      raise exception 'the website is not authorized' using errcode = '23514', hint = 'origin';
    end if;
  end if;

  if p_url is distinct from v_item.web_url then
    update public.content_items i set web_url = p_url, updated_at = now() where i.id = p_content_id;
    insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
    values ('tenant', p_tenant_id, (select auth.uid()), 'content.web_link_set', 'content_item', p_content_id,
            'success', jsonb_build_object('kind', v_item.kind, 'from', v_item.web_url, 'to', p_url));
  end if;
  return p_url;
end;
$$;

revoke all on function public.set_content_web_link(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_content_web_link(uuid, uuid, text) to authenticated;

-- What the assistant links to (anonymous): published items of a municipality in line whose
-- website is still authorized. Removing an origin turns its links off at once.
create function public.portal_web_links(p_tenant_id uuid)
returns table (kind text, slug text, url text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.kind::text, i.slug, i.web_url
  from public.content_items i
  join public.tenants t on t.id = i.tenant_id and t.status = 'active'
  where i.tenant_id = p_tenant_id
    and i.web_url is not null
    and i.published_revision_id is not null
    and i.kind in ('destination', 'event', 'notice', 'service', 'story')
    and private.web_link_origin(i.web_url) = any (private.tenant_embed_origins(p_tenant_id))
  order by i.kind, i.slug
  limit 1000;
$$;

revoke all on function public.portal_web_links(uuid) from public, anon, authenticated;
grant execute on function public.portal_web_links(uuid) to anon, authenticated;

-- ── 4. The host registry returns them ──────────────────────────────────────

-- Same columns plus `embed_origins`: the app reads its presence as «this database knows the
-- portal module» (an older one gets the portal added to its modules, ADR-071).
drop function public.resolve_tenant_by_host(text);

create function public.resolve_tenant_by_host(p_host text)
returns table (
  tenant_id        uuid,
  tenant_slug      text,
  display_name     text,
  default_locale   text,
  timezone         text,
  canonical_host   text,
  is_canonical     boolean,
  active_config_id uuid,
  is_demo          boolean,
  modules          text[],
  embed_origins    text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id,
    t.slug,
    t.display_name,
    t.default_locale,
    t.timezone,
    c.hostname,
    d.id = t.canonical_domain_id,
    t.active_config_id,
    t.is_demo,
    private.tenant_module_keys(t.id),
    private.tenant_embed_origins(t.id)
  from public.tenant_domains d
  join public.tenants t on t.id = d.tenant_id
  left join public.tenant_domains c
    on c.tenant_id = t.id and c.id = t.canonical_domain_id and c.status = 'active'
  where d.hostname = p_host
    and d.status = 'active'
    and t.status = 'active';
$$;

revoke all on function public.resolve_tenant_by_host(text) from public;
grant execute on function public.resolve_tenant_by_host(text) to anon, authenticated;
