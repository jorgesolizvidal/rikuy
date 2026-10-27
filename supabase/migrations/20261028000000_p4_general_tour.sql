-- P4 · Paso 5 — the general tour (ADR-032). Expand only.
--
-- The general tour is formed by the visible tours themselves (ADR-028); the municipality
-- only chooses their order and the tour it starts with. Both apply at once (no draft): they
-- arrange tours that are already public. A tour left out of the order goes after the ordered
-- ones, by kind and title; a start tour that is not visible is skipped.

-- ── Schema ──────────────────────────────────────────────────────────────────

create table public.general_tours (
  tenant_id     uuid primary key references public.tenants (id) on delete restrict,
  start_tour_id uuid,
  edit_count    integer not null default 0 check (edit_count >= 0),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null,

  constraint general_tours_start_fkey foreign key (tenant_id, start_tour_id)
    references public.tours (tenant_id, id) on delete restrict
);

create table public.general_tour_entries (
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  tour_id   uuid not null,
  position  integer not null check (position >= 0),

  constraint general_tour_entries_pkey primary key (tenant_id, tour_id),
  constraint general_tour_entries_position_key unique (tenant_id, position) deferrable initially deferred,
  constraint general_tour_entries_tour_fkey foreign key (tenant_id, tour_id)
    references public.tours (tenant_id, id) on delete restrict,
  constraint general_tour_entries_settings_fkey foreign key (tenant_id)
    references public.general_tours (tenant_id) on delete restrict
);

-- Read for members; writes only through the RPC.
revoke all on table public.general_tours, public.general_tour_entries from anon, authenticated;
grant select on table public.general_tours, public.general_tour_entries to authenticated;
alter table public.general_tours enable row level security;
alter table public.general_tour_entries enable row level security;

create policy general_tours_select_members
  on public.general_tours for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));
create policy general_tour_entries_select_members
  on public.general_tour_entries for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));

-- ── The panel ───────────────────────────────────────────────────────────────

-- What the panel shows: every tour with a published version, in the general tour's order,
-- with whether visitors see it now (and why not).
create function public.general_tour_editor(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'editCount', coalesce(g.edit_count, 0),
      'startTourId', g.start_tour_id,
      'tours', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'tourId', t.id,
                 'kind', i.kind,
                 'slug', i.slug,
                 'title', cp.title,
                 'position', e.position,
                 'contentPublished', cp.id is not null,
                 'ended', coalesce(v.ended, false),
                 'visible', v.tour_id is not null and not v.ended
               ) order by e.position nulls last, i.kind, coalesce(cp.title, ''))
        from public.tours t
        join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
        left join public.content_revisions cp on cp.id = i.published_revision_id
        left join public.general_tour_entries e on e.tenant_id = t.tenant_id and e.tour_id = t.id
        left join private.visible_tour(p_tenant_id) v on v.tour_id = t.id
        where t.tenant_id = p_tenant_id and t.published_revision_id is not null
      ), '[]'::jsonb)
    )
    from (select 1) one
    left join public.general_tours g on g.tenant_id = p_tenant_id
  );
end;
$$;

-- Saves the order (every tour named, once) and the start tour, as one change. Owners and
-- administrators, like publishing: the order is public as soon as it is saved.
create function public.save_general_tour(
  p_tenant_id     uuid,
  p_expected_edit integer,
  p_order         uuid[],
  p_start_tour_id uuid
)
returns table (edit_count integer, start_tour_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_settings public.general_tours;
  v_order uuid[] := coalesce(p_order, array[]::uuid[]);
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  insert into public.general_tours (tenant_id) values (p_tenant_id) on conflict (tenant_id) do nothing;
  select g.* into v_settings from public.general_tours g where g.tenant_id = p_tenant_id for update;
  if v_settings.edit_count is distinct from p_expected_edit then
    raise exception 'the general tour changed meanwhile' using errcode = 'PT409';
  end if;

  if array_length(v_order, 1) > 200 then
    raise exception 'too many tours in the order' using errcode = '22023', hint = 'order';
  end if;
  if array_position(v_order, null) is not null
     or (select count(distinct x) from unnest(v_order) x) <> cardinality(v_order) then
    raise exception 'each tour appears once in the order' using errcode = '22023', hint = 'order';
  end if;
  if exists (
    select 1 from unnest(v_order) x
    where not exists (
      select 1 from public.tours t
      where t.tenant_id = p_tenant_id and t.id = x and t.published_revision_id is not null
    )
  ) then
    raise exception 'the order names a tour that is not a published tour of this tenant'
      using errcode = '23514', hint = 'order';
  end if;
  if p_start_tour_id is not null and not exists (
    select 1 from public.tours t
    where t.tenant_id = p_tenant_id and t.id = p_start_tour_id and t.published_revision_id is not null
  ) then
    raise exception 'the start tour is not a published tour of this tenant'
      using errcode = '23514', hint = 'start';
  end if;

  delete from public.general_tour_entries e where e.tenant_id = p_tenant_id;
  insert into public.general_tour_entries (tenant_id, tour_id, position)
  select p_tenant_id, x, n::integer - 1 from unnest(v_order) with ordinality as o (x, n);

  update public.general_tours g
  set start_tour_id = p_start_tour_id,
      edit_count = g.edit_count + 1,
      updated_at = now(),
      updated_by = (select auth.uid())
  where g.tenant_id = p_tenant_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'tour.general_saved', 'general_tour', p_tenant_id,
          v_settings.edit_count + 1, 'success',
          jsonb_build_object('order', to_jsonb(v_order), 'start_tour_id', p_start_tour_id));

  return query select v_settings.edit_count + 1, p_start_tour_id;
end;
$$;

revoke all on function public.general_tour_editor(uuid) from public, anon;
revoke all on function public.save_general_tour(uuid, integer, uuid[], uuid) from public, anon;
grant execute on function public.general_tour_editor(uuid) to authenticated;
grant execute on function public.save_general_tour(uuid, integer, uuid[], uuid) to authenticated;

-- ── The portal ──────────────────────────────────────────────────────────────

-- The index, now in the municipality's order, with the tour the general tour starts with
-- (the chosen one if visitors see it, else the first). Same columns as before plus two:
-- old readers keep working.
drop function public.portal_tour_index(uuid);

create function public.portal_tour_index(p_tenant_id uuid)
returns table (
  kind          public.content_kind,
  slug          text,
  title         text,
  scenes        integer,
  entry_title   text,
  entry_folder  text,
  entry_preview jsonb,
  latitude      double precision,
  longitude     double precision,
  published_at  timestamptz,
  "position"    integer,
  is_start      boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with visible as (
    select v.*, e.position as general_position,
           row_number() over (order by e.position nulls last, v.kind, v.title) as rank
    from private.visible_tour(p_tenant_id) v
    left join public.general_tour_entries e on e.tenant_id = p_tenant_id and e.tour_id = v.tour_id
    where not v.ended
  ),
  start as (
    select coalesce(
      (select v.tour_id from visible v
       join public.general_tours g on g.tenant_id = p_tenant_id and g.start_tour_id = v.tour_id),
      (select v.tour_id from visible v order by v.rank limit 1)
    ) as tour_id
  )
  select v.kind, v.slug, v.title,
         jsonb_array_length(r.manifest -> 'scenes'),
         e ->> 'title', e #>> '{panorama,folder}', e #> '{panorama,preview}',
         v.latitude, v.longitude, v.published_at,
         (v.rank - 1)::integer,
         v.tour_id = (select s.tour_id from start s)
  from visible v
  join public.tour_revisions r on r.id = v.revision_id
  left join lateral (
    select sc from jsonb_array_elements(r.manifest -> 'scenes') sc
    where sc ->> 'sceneId' = r.manifest ->> 'entrySceneId'
  ) entry (e) on true
  order by v.rank;
$$;

revoke all on function public.portal_tour_index(uuid) from public, anon, authenticated;
grant execute on function public.portal_tour_index(uuid) to anon, authenticated;
