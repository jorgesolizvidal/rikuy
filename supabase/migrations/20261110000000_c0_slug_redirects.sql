-- C0 · Paso 1 — changing the address (slug) of a destination or event (ADR-047). Expand only.
--
--   * content_slug_redirects: the addresses a published destination or event had before.
--     Every one points to the content itself (never to the next address), so an old link
--     is one 308 away from the current page, however many times it changed.
--   * An old address stays reserved for its place: no other destination or event of that
--     kind can take it (create or rename), so a printed QR never opens another place. The
--     same place can go back to it.
--   * change_content_slug: owners and admins (as publishing), with the slug they saw.
--     A draft never published changes without leaving an old address (nobody has its link).
--   * portal_content_redirect: anonymous; the current address of an old one, only while the
--     content is published in an active municipality (otherwise the portal answers 404, as
--     before: nothing about drafts leaks).

-- ── Schema ──────────────────────────────────────────────────────────────────

create table public.content_slug_redirects (
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  kind       public.content_kind not null,
  slug       text not null,
  content_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,

  constraint content_slug_redirects_pkey primary key (tenant_id, kind, slug),
  constraint content_slug_redirects_kind check (kind in ('destination', 'event')),
  constraint content_slug_redirects_slug_format check (
    char_length(slug) between 1 and 80 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint content_slug_redirects_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete cascade
);

create index content_slug_redirects_content_idx
  on public.content_slug_redirects (tenant_id, content_id);

-- Read for members (the editor lists them); writes only through the RPC.
revoke all on table public.content_slug_redirects from anon, authenticated;
grant select on table public.content_slug_redirects to authenticated;
alter table public.content_slug_redirects enable row level security;

create policy content_slug_redirects_select_members
  on public.content_slug_redirects for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));

create trigger content_slug_redirects_forbid_tenant_change
  before update of tenant_id on public.content_slug_redirects
  for each row execute function private.forbid_tenant_change();

-- An old address belongs to a content of its own kind, and is never the current address of
-- another one.
create function private.check_slug_redirect()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.content_items i
    where i.tenant_id = new.tenant_id and i.id = new.content_id and i.kind = new.kind
  ) then
    raise exception 'an old address belongs to a content of its kind' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.content_items i
    where i.tenant_id = new.tenant_id and i.kind = new.kind and i.slug = new.slug
      and i.id <> new.content_id
  ) then
    raise exception 'this identifier is already used' using errcode = 'PT409', hint = 'slug';
  end if;
  return new;
end;
$$;

revoke all on function private.check_slug_redirect() from public;

create trigger content_slug_redirects_check
  before insert or update on public.content_slug_redirects
  for each row execute function private.check_slug_redirect();

-- Creating or renaming never takes the old address of another place (any path: the create
-- RPC, the rename RPC, a future one).
create function private.forbid_redirected_slug()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.content_slug_redirects s
    where s.tenant_id = new.tenant_id and s.kind = new.kind and s.slug = new.slug
      and s.content_id <> new.id
  ) then
    raise exception 'this identifier was used before by another place'
      using errcode = 'PT409', hint = 'slug';
  end if;
  return new;
end;
$$;

revoke all on function private.forbid_redirected_slug() from public;

create trigger content_items_forbid_redirected_slug
  before insert or update of slug on public.content_items
  for each row execute function private.forbid_redirected_slug();

-- ── The panel ───────────────────────────────────────────────────────────────

-- Owners and admins change the address of a destination or event. p_expected_slug is the
-- address the person saw: if someone changed it meanwhile, nothing changes (stale).
create function public.change_content_slug(
  p_tenant_id uuid,
  p_content_id uuid,
  p_expected_slug text,
  p_slug text
)
returns table (slug text, previous_slug text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item public.content_items%rowtype;
  v_published boolean;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select * into v_item from public.content_items i
  where i.tenant_id = p_tenant_id and i.id = p_content_id
  for update;
  if not found or v_item.kind not in ('destination', 'event') then
    raise exception 'content not found' using errcode = 'PT404';
  end if;

  if p_slug is null or char_length(p_slug) not between 1 and 80
     or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'invalid identifier' using errcode = '23514', hint = 'slug';
  end if;
  if p_expected_slug is distinct from v_item.slug then
    raise exception 'the address changed meanwhile' using errcode = 'PT409', hint = 'stale';
  end if;
  if p_slug = v_item.slug then
    raise exception 'the address is the same' using errcode = '23514', hint = 'unchanged';
  end if;
  if exists (
    select 1 from public.content_items i
    where i.tenant_id = p_tenant_id and i.kind = v_item.kind and i.slug = p_slug
  ) then
    raise exception 'this identifier is already used' using errcode = 'PT409', hint = 'slug';
  end if;
  if exists (
    select 1 from public.content_slug_redirects s
    where s.tenant_id = p_tenant_id and s.kind = v_item.kind and s.slug = p_slug
      and s.content_id <> p_content_id
  ) then
    raise exception 'this identifier was used before by another place'
      using errcode = 'PT409', hint = 'previous';
  end if;

  -- Ever published: visitors may have its link or its QR.
  v_published := exists (
    select 1 from public.content_revisions r
    where r.tenant_id = p_tenant_id and r.content_id = p_content_id and r.state = 'sealed'
  );

  -- Going back to an old address: it is the current one again.
  delete from public.content_slug_redirects s
  where s.tenant_id = p_tenant_id and s.kind = v_item.kind and s.slug = p_slug
    and s.content_id = p_content_id;

  if v_published then
    if (select count(*) from public.content_slug_redirects s
        where s.tenant_id = p_tenant_id and s.content_id = p_content_id) >= 20 then
      raise exception 'too many old addresses' using errcode = 'PT409', hint = 'too_many';
    end if;
    insert into public.content_slug_redirects (tenant_id, kind, slug, content_id, created_by)
    values (p_tenant_id, v_item.kind, v_item.slug, p_content_id, (select auth.uid()));
  end if;

  update public.content_items i set slug = p_slug, updated_at = now() where i.id = p_content_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'content.slug_changed', 'content_item', p_content_id,
          'success', jsonb_build_object('kind', v_item.kind, 'from', v_item.slug, 'to', p_slug,
                                        'kept_old', v_published));

  return query select p_slug, case when v_published then v_item.slug end;
exception when unique_violation then
  raise exception 'this identifier is already used' using errcode = 'PT409', hint = 'slug';
end;
$$;

revoke all on function public.change_content_slug(uuid, uuid, text, text) from public, anon;
grant execute on function public.change_content_slug(uuid, uuid, text, text) to authenticated;

-- ── The portal ──────────────────────────────────────────────────────────────

-- The current address of an old one, while visitors can see the content.
create function public.portal_content_redirect(
  p_tenant_id uuid,
  p_kind public.content_kind,
  p_slug text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select i.slug
  from public.content_slug_redirects s
  join public.tenants t on t.id = s.tenant_id and t.status = 'active'
  join public.content_items i on i.tenant_id = s.tenant_id and i.id = s.content_id
  where s.tenant_id = p_tenant_id and s.kind = p_kind and s.slug = p_slug
    and i.published_revision_id is not null;
$$;

revoke all on function public.portal_content_redirect(uuid, public.content_kind, text) from public, anon, authenticated;
grant execute on function public.portal_content_redirect(uuid, public.content_kind, text) to anon, authenticated;
