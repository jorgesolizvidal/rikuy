-- C0 · Paso 3 — borrar un tour o pasarlo a otro destino o evento (ADR-049).
--
-- Decisions of the user (2026-11-10):
-- - deleting is final: the tour, its revisions and its history go; its panoramas and models
--   are then free to delete in the panel (ADR-048);
-- - only owners and admins delete or move a tour;
-- - "go to another tour" points of other tours that led to it keep pointing to their place:
--   without a visible tour there the portal hides them (as today), and the panel says which;
-- - the tour's old address takes visitors where it is now: a moved tour's page, else the
--   place's page.
--
-- Only expand: new table, new functions, a new trigger function for sealed tour revisions
-- (the shared `protect_sealed_revision` is not touched) and `portal_tour` without self links.

-- ── Where a moved tour went ─────────────────────────────────────────────────────
-- One row per place a tour left: its old tour page leads to the tour, wherever it is now.
-- Deleting the tour deletes the rows (its old pages then lead to their places).
create table public.tour_redirects (
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  content_id uuid not null,
  tour_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, content_id),
  foreign key (tenant_id, content_id) references public.content_items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, tour_id) references public.tours (tenant_id, id) on delete cascade
);
create index tour_redirects_tour_idx on public.tour_redirects (tenant_id, tour_id);

alter table public.tour_redirects enable row level security;
revoke all on public.tour_redirects from public, anon, authenticated;

-- A place that gets a tour (created or moved there) no longer redirects anywhere.
create function private.clear_tour_redirect()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.tour_redirects r where r.tenant_id = new.tenant_id and r.content_id = new.content_id;
  return null;
end;
$$;

create trigger tours_clear_redirect
  after insert or update of content_id on public.tours
  for each row execute function private.clear_tour_redirect();

-- ── Deleting sealed revisions, only from `delete_tour` ──────────────────────────
-- A sealed revision stays immutable; the one way to remove it is deleting its whole tour,
-- marked here for the current transaction by `delete_tour` (nobody else can write this).
create table private.tour_deletions (
  tour_id uuid primary key,
  xact xid8 not null
);
revoke all on private.tour_deletions from public, anon, authenticated;

create function private.protect_sealed_tour_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.state = 'sealed' then
    if tg_op = 'DELETE' and exists (
      select 1 from private.tour_deletions d
      where d.tour_id = old.tour_id and d.xact = pg_current_xact_id()
    ) then
      return old;
    end if;
    raise exception 'sealed revisions are immutable' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger tour_revisions_protect_sealed on public.tour_revisions;
create trigger tour_revisions_protect_sealed
  before update or delete on public.tour_revisions
  for each row execute function private.protect_sealed_tour_revision();

-- ── What deleting or moving a tour changes ─────────────────────────────────────
-- Any member: its revisions, whether it is in the general tour (and starts it), and the other
-- tours with a "go to another tour" point leading to its place (in their draft, published
-- version or only an older one).
create function public.tour_removal_impact(p_tenant_id uuid, p_tour_id uuid)
returns table (
  content_id uuid,
  revisions integer,
  published boolean,
  in_general_tour boolean,
  starts_general_tour boolean,
  linked_from jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tour public.tours%rowtype;
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  select t.* into v_tour from public.tours t where t.tenant_id = p_tenant_id and t.id = p_tour_id;
  if not found then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;

  return query
  select v_tour.content_id,
         (select count(*)::integer from public.tour_revisions r where r.tour_id = v_tour.id and r.state = 'sealed'),
         v_tour.published_revision_id is not null,
         exists (select 1 from public.general_tour_entries e where e.tenant_id = p_tenant_id and e.tour_id = v_tour.id),
         exists (select 1 from public.general_tours g where g.tenant_id = p_tenant_id and g.start_tour_id = v_tour.id),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'tourId', l.tour_id, 'contentKind', l.kind, 'contentTitle', l.title,
                    'draft', l.draft, 'published', l.published
                  ) order by l.title, l.tour_id)
           from (
             select o.id as tour_id, i.kind,
                    coalesce(cr.title, i.slug) as title,
                    bool_or(r.id is not distinct from o.draft_revision_id) as draft,
                    bool_or(r.id is not distinct from o.published_revision_id) as published
             from public.tour_hotspots h
             join public.tour_revisions r on r.tenant_id = h.tenant_id and r.id = h.tour_revision_id
             join public.tours o on o.tenant_id = r.tenant_id and o.id = r.tour_id
             join public.content_items i on i.tenant_id = o.tenant_id and i.id = o.content_id
             left join public.content_revisions cr on cr.id = coalesce(i.draft_revision_id, i.published_revision_id)
             where h.tenant_id = p_tenant_id and h.kind = 'tour'
               and h.target_content_id = v_tour.content_id and o.id <> v_tour.id
             group by o.id, i.kind, coalesce(cr.title, i.slug)
           ) l
         ), '[]'::jsonb);
end;
$$;

revoke all on function public.tour_removal_impact(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tour_removal_impact(uuid, uuid) to authenticated;

-- The places a tour left (their old tour pages lead to it), as [{kind, slug}].
create function private.former_tour_places(p_tenant_id uuid, p_tour_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'slug', i.slug) order by i.slug), '[]'::jsonb)
  from public.tour_redirects r
  join public.content_items i on i.tenant_id = r.tenant_id and i.id = r.content_id
  where r.tenant_id = p_tenant_id and r.tour_id = p_tour_id;
$$;

-- ── Delete ──────────────────────────────────────────────────────────────────
-- Owners and admins: the tour, every revision (sealed ones too), its scenes and points, its
-- place in the general tour and what the assistant read from it, in one transaction. Returns
-- its place (for the panel and the portal's cache). Its media are then free (ADR-048).
-- Error codes: 42501 forbidden · PT404 unknown.
create function public.delete_tour(p_tenant_id uuid, p_tour_id uuid)
returns table (content_kind public.content_kind, content_slug text, former_places jsonb)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tour public.tours%rowtype;
  v_item public.content_items%rowtype;
  v_revisions integer;
  v_linked integer;
  v_former jsonb;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  select t.* into v_tour from public.tours t
  where t.tenant_id = p_tenant_id and t.id = p_tour_id
  for update;
  if not found then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;
  select i.* into v_item from public.content_items i
  where i.tenant_id = p_tenant_id and i.id = v_tour.content_id;
  v_former := private.former_tour_places(p_tenant_id, v_tour.id);

  select count(*)::integer into v_revisions from public.tour_revisions r where r.tour_id = v_tour.id;
  select count(distinct r.tour_id)::integer into v_linked
  from public.tour_hotspots h
  join public.tour_revisions r on r.tenant_id = h.tenant_id and r.id = h.tour_revision_id
  where h.tenant_id = p_tenant_id and h.kind = 'tour' and h.target_content_id = v_tour.content_id
    and r.tour_id <> v_tour.id;

  -- The general tour: out of it, positions without gaps, another start (the first one), and
  -- an editor with the old order open must reload.
  if exists (select 1 from public.general_tour_entries e where e.tenant_id = p_tenant_id and e.tour_id = v_tour.id)
     or exists (select 1 from public.general_tours g where g.tenant_id = p_tenant_id and g.start_tour_id = v_tour.id) then
    delete from public.general_tour_entries e where e.tenant_id = p_tenant_id and e.tour_id = v_tour.id;
    update public.general_tour_entries e
    set position = n.position
    from (
      select x.tour_id, (row_number() over (order by x.position) - 1)::integer as position
      from public.general_tour_entries x where x.tenant_id = p_tenant_id
    ) n
    where e.tenant_id = p_tenant_id and e.tour_id = n.tour_id and e.position <> n.position;
    update public.general_tours g
    set start_tour_id = case when g.start_tour_id = v_tour.id then null else g.start_tour_id end,
        edit_count = g.edit_count + 1,
        updated_at = now(),
        updated_by = (select auth.uid())
    where g.tenant_id = p_tenant_id;
  end if;

  -- What the assistant read from it.
  delete from public.knowledge_chunks c where c.tenant_id = p_tenant_id and c.tour_id = v_tour.id;
  delete from public.knowledge_indexed_revisions k
  where k.tour_revision_id in (select r.id from public.tour_revisions r where r.tour_id = v_tour.id);

  -- The tour and every revision (scenes, points and photos go with them).
  insert into private.tour_deletions (tour_id, xact) values (v_tour.id, pg_current_xact_id())
  on conflict (tour_id) do update set xact = excluded.xact;
  update public.tours t
  set draft_revision_id = null, published_revision_id = null, published_at = null
  where t.id = v_tour.id;
  delete from public.tour_revisions r where r.tenant_id = p_tenant_id and r.tour_id = v_tour.id;
  delete from public.tours t where t.id = v_tour.id;
  delete from private.tour_deletions d where d.tour_id = v_tour.id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'tour.deleted', 'tour', v_tour.id, 'success',
          jsonb_build_object('content_id', v_tour.content_id, 'revisions', v_revisions,
                             'was_published', v_tour.published_revision_id is not null,
                             'linked_from', v_linked));

  return query select v_item.kind, v_item.slug, v_former;
end;
$$;

revoke all on function public.delete_tour(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_tour(uuid, uuid) to authenticated;

-- ── Move ────────────────────────────────────────────────────────────────────
-- Owners and admins: the tour goes, whole (draft, published version and history), to another
-- destination or event of the municipality that has no tour. Its old page leads to the new
-- one; what the assistant read from it now carries the new place's name. Returns both places
-- and the places it had left before (for the portal's cache).
-- Error codes: 42501 forbidden · PT404 unknown tour or place · 23514 hint 'kind' (not a
-- destination or event) · PT409 hints 'same', 'taken', 'self_link' (its draft, or its
-- published version without a draft, has a "go to another tour" point leading to that place).
create function public.move_tour(p_tenant_id uuid, p_tour_id uuid, p_content_id uuid)
returns table (
  from_kind public.content_kind,
  from_slug text,
  to_kind public.content_kind,
  to_slug text,
  former_places jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tour public.tours%rowtype;
  v_from public.content_items%rowtype;
  v_to public.content_items%rowtype;
  v_former jsonb;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  select t.* into v_tour from public.tours t
  where t.tenant_id = p_tenant_id and t.id = p_tour_id
  for update;
  if not found then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;
  select i.* into v_to from public.content_items i where i.tenant_id = p_tenant_id and i.id = p_content_id;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;
  if v_to.kind not in ('destination', 'event') then
    raise exception 'only destinations and events have tours' using errcode = '23514', hint = 'kind';
  end if;
  if v_tour.content_id = p_content_id then
    raise exception 'the tour is already there' using errcode = 'PT409', hint = 'same';
  end if;
  if exists (select 1 from public.tours t where t.tenant_id = p_tenant_id and t.content_id = p_content_id) then
    raise exception 'that place already has a tour' using errcode = 'PT409', hint = 'taken';
  end if;
  if exists (
    select 1 from public.tour_hotspots h
    where h.tenant_id = p_tenant_id
      and h.tour_revision_id = coalesce(v_tour.draft_revision_id, v_tour.published_revision_id)
      and h.kind = 'tour' and h.target_content_id = p_content_id
  ) then
    raise exception 'a point of the tour leads to that place' using errcode = 'PT409', hint = 'self_link';
  end if;
  select i.* into v_from from public.content_items i where i.tenant_id = p_tenant_id and i.id = v_tour.content_id;
  v_former := private.former_tour_places(p_tenant_id, v_tour.id);

  update public.tours t set content_id = p_content_id, updated_at = now() where t.id = v_tour.id;
  insert into public.tour_redirects (tenant_id, content_id, tour_id)
  values (p_tenant_id, v_from.id, v_tour.id)
  on conflict (tenant_id, content_id) do update set tour_id = excluded.tour_id, created_at = now();

  -- The assistant cites the tour under its new place (the passages keep their text).
  update public.knowledge_chunks c
  set title = coalesce(
    (select cr.title from public.content_revisions cr where cr.id = v_to.published_revision_id),
    v_to.slug
  )
  where c.tenant_id = p_tenant_id and c.tour_id = v_tour.id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'tour.moved', 'tour', v_tour.id, 'success',
          jsonb_build_object('from', v_from.id, 'to', v_to.id));

  return query select v_from.kind, v_from.slug, v_to.kind, v_to.slug, v_former;
end;
$$;

revoke all on function public.move_tour(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.move_tour(uuid, uuid, uuid) to authenticated;

-- ── The portal ──────────────────────────────────────────────────────────────
-- A published tour never offers a "go to another tour" point to its own place (it can lead
-- there after a move, in its history).
create or replace function public.portal_tour(p_tenant_id uuid, p_kind public.content_kind, p_slug text)
returns table (
  kind public.content_kind,
  slug text,
  title text,
  revision_no integer,
  published_at timestamptz,
  ended boolean,
  manifest jsonb,
  targets jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.kind, v.slug, v.title, r.revision_no, v.published_at, v.ended, r.manifest,
         coalesce((
           select jsonb_object_agg(o.content_id, jsonb_build_object('kind', o.kind, 'slug', o.slug, 'title', o.title))
           from private.visible_tour(p_tenant_id) o
           where o.content_id <> v.content_id
             and o.content_id in (
               select (h ->> 'targetContentId')::uuid
               from jsonb_array_elements(r.manifest -> 'scenes') sc,
                    jsonb_array_elements(sc -> 'hotspots') h
               where h ->> 'kind' = 'tour'
             )
         ), '{}'::jsonb)
  from private.visible_tour(p_tenant_id) v
  join public.tour_revisions r on r.id = v.revision_id
  where v.kind = p_kind and v.slug = p_slug;
$$;

-- For a tour page that is not found: a published place whose tour moved leads to that tour
-- (when visitors can open it); any other published place leads to its own page. Nothing for
-- an unknown or unpublished place, or a suspended municipality. Anonymous.
create function public.portal_tour_redirect(p_tenant_id uuid, p_kind public.content_kind, p_slug text)
returns table (kind public.content_kind, slug text, target text)
language sql
stable
security definer
set search_path = ''
as $$
  with place as (
    select i.*
    from public.content_items i
    join public.tenants tn on tn.id = i.tenant_id and tn.status = 'active'
    where i.tenant_id = p_tenant_id and i.kind = p_kind and i.slug = p_slug
      and i.kind in ('destination', 'event') and i.published_revision_id is not null
      and not exists (select 1 from private.visible_tour(p_tenant_id) v where v.content_id = i.id)
  ),
  moved as (
    select v.kind, v.slug
    from place p
    join public.tour_redirects r on r.tenant_id = p.tenant_id and r.content_id = p.id
    join private.visible_tour(p_tenant_id) v on v.tour_id = r.tour_id
  )
  select m.kind, m.slug, 'tour' from moved m
  union all
  select p.kind, p.slug, 'place' from place p where not exists (select 1 from moved)
  limit 1;
$$;

revoke all on function public.portal_tour_redirect(uuid, public.content_kind, text) from public;
grant execute on function public.portal_tour_redirect(uuid, public.content_kind, text) to anon, authenticated;
