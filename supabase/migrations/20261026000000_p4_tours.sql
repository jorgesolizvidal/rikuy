-- ─────────────────────────────────────────────────────────────────────────────
-- P4 · Paso 1: tours 360° and their scenes (pilot schema tables 7–9, ADR-028).
--
--   * tours: at most one per destination or event (optional). Two pointers, like content
--     items: the one open draft and the published (sealed) revision.
--   * tour_revisions: numbered snapshots of the tour's graph. ONE entry scene, as a column
--     of the revision (no "initial" flag on scenes). A draft may have none; sealing needs a
--     valid one. Edited with optimistic concurrency (edit_count); sealed = immutable.
--   * tour_scenes: a ready panorama version with its order, title, description and initial
--     view. scene_id is stable across revisions (copied when a new draft opens), so links
--     to a scene (hotspots, P4 · Paso 2) survive edits and rollbacks.
--   * Edits are small intent RPCs (add, change, move, remove, set entry): a form never
--     rewrites what it did not show (RC-01). Each one checks and bumps edit_count.
--   * Publishing here seals and points; making the media public and the tour manifest come
--     with P4 · Paso 3.
-- Expand-only.
-- Error codes: 42501 forbidden · 23514 invalid · PT404 unknown · PT409 conflict/state.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tables ──────────────────────────────────────────────────────────────────

create table public.tours (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete restrict,
  content_id            uuid not null,
  draft_revision_id     uuid,
  published_revision_id uuid,
  published_at          timestamptz,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint tours_tenant_id_id_key unique (tenant_id, id),
  -- One tour per destination or event.
  constraint tours_tenant_content_key unique (tenant_id, content_id),
  constraint tours_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete restrict,
  constraint tours_published_has_timestamp check ((published_revision_id is null) = (published_at is null))
);

create table public.tour_revisions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  tour_id        uuid not null,
  revision_no    integer not null,
  state          public.config_state not null default 'draft',
  edit_count     integer not null default 1,
  entry_scene_id uuid,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_by     uuid references auth.users (id) on delete set null,
  updated_at     timestamptz not null default now(),
  sealed_by      uuid references auth.users (id) on delete set null,
  sealed_at      timestamptz,

  constraint tour_revisions_tenant_id_id_key unique (tenant_id, id),
  constraint tour_revisions_tour_id_id_key unique (tour_id, id),
  constraint tour_revisions_tour_no_key unique (tenant_id, tour_id, revision_no),
  constraint tour_revisions_tour_fkey foreign key (tenant_id, tour_id)
    references public.tours (tenant_id, id) on delete restrict,
  constraint tour_revisions_revision_positive check (revision_no >= 1),
  constraint tour_revisions_edit_positive check (edit_count >= 1),
  constraint tour_revisions_sealed_has_timestamp check ((state = 'sealed') = (sealed_at is not null)),
  constraint tour_revisions_sealed_has_entry check (state <> 'sealed' or entry_scene_id is not null)
);

-- One open draft per tour.
create unique index tour_revisions_one_draft_idx on public.tour_revisions (tour_id) where state = 'draft';

create table public.tour_scenes (
  tenant_id            uuid not null,
  tour_revision_id     uuid not null,
  scene_id             uuid not null,
  position             smallint not null,
  title                text not null,
  description          text not null default '',
  panorama_version_id  uuid not null,
  initial_yaw          double precision not null default 0,
  initial_pitch        double precision not null default 0,
  initial_fov          double precision not null default 60,

  constraint tour_scenes_pkey primary key (tenant_id, tour_revision_id, scene_id),
  constraint tour_scenes_revision_fkey foreign key (tenant_id, tour_revision_id)
    references public.tour_revisions (tenant_id, id) on delete cascade,
  constraint tour_scenes_panorama_fkey foreign key (tenant_id, panorama_version_id)
    references public.asset_versions (tenant_id, id) on delete restrict,
  -- Moving a scene shifts the others inside one statement.
  constraint tour_scenes_position_key unique (tour_revision_id, position) deferrable initially deferred,
  -- A panorama appears once per tour.
  constraint tour_scenes_panorama_key unique (tour_revision_id, panorama_version_id),
  constraint tour_scenes_position_range check (position between 0 and 59),
  constraint tour_scenes_title check (
    char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]' and title = btrim(title)
  ),
  constraint tour_scenes_description check (
    char_length(description) <= 1000 and description !~ '[[:cntrl:]]' and description = btrim(description)
  ),
  -- Angles in radians, independent of how the image is delivered (ADR-020).
  constraint tour_scenes_initial_view check (
    initial_yaw >= -pi() and initial_yaw < pi()
    and initial_pitch between -pi() / 2 and pi() / 2
    and initial_fov between 30 and 90
  )
);

create index tour_scenes_panorama_idx on public.tour_scenes (tenant_id, panorama_version_id);

-- Pointers name revisions of the SAME tour; the entry scene is a scene of the SAME revision.
alter table public.tours
  add constraint tours_draft_fkey
    foreign key (id, draft_revision_id) references public.tour_revisions (tour_id, id)
    deferrable initially deferred,
  add constraint tours_published_fkey
    foreign key (id, published_revision_id) references public.tour_revisions (tour_id, id)
    deferrable initially deferred;
alter table public.tour_revisions
  add constraint tour_revisions_entry_fkey
    foreign key (tenant_id, id, entry_scene_id)
    references public.tour_scenes (tenant_id, tour_revision_id, scene_id)
    deferrable initially deferred;

-- ── Integrity triggers ─────────────────────────────────────────────────────

create trigger tour_revisions_protect_sealed
  before update or delete on public.tour_revisions
  for each row execute function private.protect_sealed_revision();

create function private.protect_sealed_tour_scene()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision uuid := case when tg_op = 'INSERT' then new.tour_revision_id else old.tour_revision_id end;
begin
  if exists (select 1 from public.tour_revisions r where r.id = v_revision and r.state = 'sealed') then
    raise exception 'scenes of a sealed revision are immutable' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.protect_sealed_tour_scene() from public;

create trigger tour_scenes_protect_sealed
  before insert or update or delete on public.tour_scenes
  for each row execute function private.protect_sealed_tour_scene();

create trigger tours_forbid_tenant_change
  before update of tenant_id on public.tours
  for each row execute function private.forbid_tenant_change();
create trigger tour_revisions_forbid_tenant_change
  before update of tenant_id on public.tour_revisions
  for each row execute function private.forbid_tenant_change();
create trigger tour_scenes_forbid_tenant_change
  before update of tenant_id on public.tour_scenes
  for each row execute function private.forbid_tenant_change();

-- ── Privileges and RLS (read for members; writes only through RPCs) ────────

revoke all on table public.tours, public.tour_revisions, public.tour_scenes from anon, authenticated;
grant select on table public.tours, public.tour_revisions, public.tour_scenes to authenticated;

alter table public.tours enable row level security;
alter table public.tour_revisions enable row level security;
alter table public.tour_scenes enable row level security;

create policy tours_select_members
  on public.tours for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));
create policy tour_revisions_select_members
  on public.tour_revisions for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));
create policy tour_scenes_select_members
  on public.tour_scenes for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- A ready panorama version of this tenant, or an error.
create function private.tour_panorama_version(p_tenant_id uuid, p_version_id uuid)
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
  where v.tenant_id = p_tenant_id and v.id = p_version_id
    and a.purpose = 'panorama' and v.status = 'ready';
  if v_id is null then
    raise exception 'the panorama is not ready or not of this tenant' using errcode = '23514', hint = 'panorama';
  end if;
  return v_id;
end;
$$;

revoke all on function private.tour_panorama_version(uuid, uuid) from public;

-- The draft to edit, under the tour's lock. With no open draft (expected edit null) a new
-- one is opened as a copy of the published revision, scene ids included. Otherwise the
-- caller's edit_count must match. Either way the edit is counted.
create function private.tour_draft_for_edit(p_tenant_id uuid, p_tour_id uuid, p_expected_edit integer)
returns public.tour_revisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tour public.tours;
  v_draft public.tour_revisions;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select t.* into v_tour from public.tours t
  where t.id = p_tour_id and t.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;

  if v_tour.draft_revision_id is null then
    if p_expected_edit is not null then
      raise exception 'the draft was published or discarded meanwhile' using errcode = 'PT409';
    end if;
    if v_tour.published_revision_id is null then
      raise exception 'tour without revisions' using errcode = 'PT409';
    end if;
    insert into public.tour_revisions (tenant_id, tour_id, revision_no, created_by, updated_by)
    values (
      p_tenant_id, p_tour_id,
      (select max(r.revision_no) + 1 from public.tour_revisions r where r.tour_id = p_tour_id),
      (select auth.uid()), (select auth.uid())
    )
    returning * into v_draft;
    insert into public.tour_scenes (
      tenant_id, tour_revision_id, scene_id, position, title, description, panorama_version_id,
      initial_yaw, initial_pitch, initial_fov
    )
    select s.tenant_id, v_draft.id, s.scene_id, s.position, s.title, s.description, s.panorama_version_id,
           s.initial_yaw, s.initial_pitch, s.initial_fov
    from public.tour_scenes s
    where s.tour_revision_id = v_tour.published_revision_id;
    -- The entry after its scene exists (the reference is checked per statement in tests).
    update public.tour_revisions r
    set entry_scene_id = (select p.entry_scene_id from public.tour_revisions p where p.id = v_tour.published_revision_id)
    where r.id = v_draft.id
    returning * into v_draft;
    update public.tours t set draft_revision_id = v_draft.id, updated_at = now() where t.id = p_tour_id;
    return v_draft;
  end if;

  select r.* into v_draft from public.tour_revisions r where r.id = v_tour.draft_revision_id for update;
  if p_expected_edit is distinct from v_draft.edit_count then
    raise exception 'the draft changed meanwhile' using errcode = 'PT409';
  end if;
  update public.tour_revisions r
  set edit_count = r.edit_count + 1, updated_by = (select auth.uid()), updated_at = now()
  where r.id = v_draft.id
  returning * into v_draft;
  update public.tours t set updated_at = now() where t.id = p_tour_id;
  return v_draft;
end;
$$;

revoke all on function private.tour_draft_for_edit(uuid, uuid, integer) from public;

-- Keeps positions compact (0..n-1) in their current order.
create function private.compact_tour_scenes(p_revision_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.tour_scenes s
  set position = o.rn - 1
  from (
    select x.scene_id, row_number() over (order by x.position) as rn
    from public.tour_scenes x where x.tour_revision_id = p_revision_id
  ) o
  where s.tour_revision_id = p_revision_id and s.scene_id = o.scene_id and s.position <> o.rn - 1;
$$;

revoke all on function private.compact_tour_scenes(uuid) from public;

-- One revision as the editor and the portal know it.
create function private.tour_revision_document(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'revisionId', r.id,
    'revisionNo', r.revision_no,
    'state', r.state,
    'editCount', r.edit_count,
    'entrySceneId', r.entry_scene_id,
    'updatedAt', r.updated_at,
    'sealedAt', r.sealed_at,
    'scenes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sceneId', s.scene_id,
        'position', s.position,
        'title', s.title,
        'description', s.description,
        'initialView', jsonb_build_object('yaw', s.initial_yaw, 'pitch', s.initial_pitch, 'fov', s.initial_fov),
        'panorama', jsonb_build_object(
          'versionId', v.id, 'assetId', v.asset_id, 'version', v.version,
          'width', v.width, 'height', v.height, 'manifest', v.manifest
        )
      ) order by s.position)
      from public.tour_scenes s
      join public.asset_versions v on v.tenant_id = s.tenant_id and v.id = s.panorama_version_id
      where s.tour_revision_id = r.id
    ), '[]'::jsonb)
  )
  from public.tour_revisions r
  where r.id = p_revision_id;
$$;

revoke all on function private.tour_revision_document(uuid) from public;

-- ── Intent RPCs ─────────────────────────────────────────────────────────────

-- Owners, admins and editors give a destination or event its tour (empty first draft).
create function public.create_tour(p_tenant_id uuid, p_content_id uuid)
returns table (tour_id uuid, revision_id uuid, edit_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tour uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);
  if not exists (select 1 from public.content_items i where i.id = p_content_id and i.tenant_id = p_tenant_id) then
    raise exception 'content not found' using errcode = 'PT404';
  end if;
  if exists (select 1 from public.tours t where t.tenant_id = p_tenant_id and t.content_id = p_content_id) then
    raise exception 'this content already has a tour' using errcode = 'PT409', hint = 'exists';
  end if;

  insert into public.tours (id, tenant_id, content_id, created_by) values (v_tour, p_tenant_id, p_content_id, (select auth.uid()));
  insert into public.tour_revisions (id, tenant_id, tour_id, revision_no, created_by, updated_by)
  values (v_revision, p_tenant_id, v_tour, 1, (select auth.uid()), (select auth.uid()));
  update public.tours t set draft_revision_id = v_revision where t.id = v_tour;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'tour.created', 'tour', v_tour, 1, 'success',
          jsonb_build_object('content_id', p_content_id));

  return query select v_tour, v_revision, 1;
exception when unique_violation then
  raise exception 'this content already has a tour' using errcode = 'PT409', hint = 'exists';
end;
$$;

-- Adds a ready panorama as the last scene. The first scene becomes the entry.
create function public.add_tour_scene(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_expected_edit integer,
  p_panorama_version_id uuid,
  p_title text
)
returns table (revision_id uuid, edit_count integer, scene_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft public.tour_revisions;
  v_scene uuid := gen_random_uuid();
  v_count integer;
begin
  v_draft := private.tour_draft_for_edit(p_tenant_id, p_tour_id, p_expected_edit);
  if not private.is_plain_line(to_jsonb(p_title), 1, 120) then
    raise exception 'invalid scene title' using errcode = '23514', hint = 'title';
  end if;
  perform private.tour_panorama_version(p_tenant_id, p_panorama_version_id);
  if exists (
    select 1 from public.tour_scenes s
    where s.tour_revision_id = v_draft.id and s.panorama_version_id = p_panorama_version_id
  ) then
    raise exception 'this panorama is already a scene of the tour' using errcode = 'PT409', hint = 'duplicate';
  end if;
  select count(*) into v_count from public.tour_scenes s where s.tour_revision_id = v_draft.id;
  if v_count >= 60 then
    raise exception 'a tour has at most 60 scenes' using errcode = '23514', hint = 'limit';
  end if;

  insert into public.tour_scenes (tenant_id, tour_revision_id, scene_id, position, title, panorama_version_id)
  values (p_tenant_id, v_draft.id, v_scene, v_count, p_title, p_panorama_version_id);
  if v_draft.entry_scene_id is null then
    update public.tour_revisions r set entry_scene_id = v_scene where r.id = v_draft.id;
  end if;

  return query select v_draft.id, v_draft.edit_count, v_scene;
end;
$$;

-- Changes only the fields present: title, description, initialView {yaw, pitch, fov}.
-- What a form does not send stays as it was (RC-01).
create function public.update_tour_scene(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_expected_edit integer,
  p_scene_id uuid,
  p_changes jsonb
)
returns table (revision_id uuid, edit_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft public.tour_revisions;
  v_view jsonb := p_changes -> 'initialView';
begin
  v_draft := private.tour_draft_for_edit(p_tenant_id, p_tour_id, p_expected_edit);
  if not exists (select 1 from public.tour_scenes s where s.tour_revision_id = v_draft.id and s.scene_id = p_scene_id) then
    raise exception 'scene not found' using errcode = 'PT404';
  end if;
  if p_changes is null
     or not private.has_exact_keys(p_changes, '{}', array['title', 'description', 'initialView'])
     or p_changes = '{}'::jsonb
     or (p_changes ? 'title' and not private.is_plain_line(p_changes -> 'title', 1, 120))
     or (p_changes ? 'description' and not private.is_plain_line(p_changes -> 'description', 0, 1000))
     or (p_changes ? 'initialView' and not (
       private.has_exact_keys(v_view, array['yaw', 'pitch', 'fov'])
       and jsonb_typeof(v_view -> 'yaw') = 'number'
       and jsonb_typeof(v_view -> 'pitch') = 'number'
       and jsonb_typeof(v_view -> 'fov') = 'number'
       and (v_view ->> 'yaw')::double precision >= -pi() and (v_view ->> 'yaw')::double precision < pi()
       and (v_view ->> 'pitch')::double precision between -pi() / 2 and pi() / 2
       and (v_view ->> 'fov')::double precision between 30 and 90
     )) then
    raise exception 'invalid scene changes' using errcode = '23514';
  end if;

  update public.tour_scenes s
  set title = case when p_changes ? 'title' then p_changes ->> 'title' else s.title end,
      description = case when p_changes ? 'description' then p_changes ->> 'description' else s.description end,
      initial_yaw = case when v_view is not null then (v_view ->> 'yaw')::double precision else s.initial_yaw end,
      initial_pitch = case when v_view is not null then (v_view ->> 'pitch')::double precision else s.initial_pitch end,
      initial_fov = case when v_view is not null then (v_view ->> 'fov')::double precision else s.initial_fov end
  where s.tour_revision_id = v_draft.id and s.scene_id = p_scene_id;

  return query select v_draft.id, v_draft.edit_count;
end;
$$;

-- Moves a scene to a position (0-based); the others shift. The entry does not change.
create function public.move_tour_scene(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_expected_edit integer,
  p_scene_id uuid,
  p_position integer
)
returns table (revision_id uuid, edit_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft public.tour_revisions;
  v_from integer;
  v_count integer;
begin
  v_draft := private.tour_draft_for_edit(p_tenant_id, p_tour_id, p_expected_edit);
  select s.position into v_from from public.tour_scenes s
  where s.tour_revision_id = v_draft.id and s.scene_id = p_scene_id;
  if v_from is null then
    raise exception 'scene not found' using errcode = 'PT404';
  end if;
  select count(*) into v_count from public.tour_scenes s where s.tour_revision_id = v_draft.id;
  if p_position is null or p_position < 0 or p_position >= v_count then
    raise exception 'invalid position' using errcode = '23514';
  end if;

  update public.tour_scenes s
  set position = case
    when s.scene_id = p_scene_id then p_position
    when p_position < v_from and s.position >= p_position and s.position < v_from then s.position + 1
    when p_position > v_from and s.position <= p_position and s.position > v_from then s.position - 1
    else s.position
  end
  where s.tour_revision_id = v_draft.id;

  return query select v_draft.id, v_draft.edit_count;
end;
$$;

-- Removes a scene. If it was the entry, the first remaining scene becomes the entry.
create function public.remove_tour_scene(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_expected_edit integer,
  p_scene_id uuid
)
returns table (revision_id uuid, edit_count integer, entry_scene_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft public.tour_revisions;
  v_entry uuid;
begin
  v_draft := private.tour_draft_for_edit(p_tenant_id, p_tour_id, p_expected_edit);
  if not exists (select 1 from public.tour_scenes s where s.tour_revision_id = v_draft.id and s.scene_id = p_scene_id) then
    raise exception 'scene not found' using errcode = 'PT404';
  end if;

  v_entry := v_draft.entry_scene_id;
  if v_entry = p_scene_id then
    select s.scene_id into v_entry from public.tour_scenes s
    where s.tour_revision_id = v_draft.id and s.scene_id <> p_scene_id
    order by s.position limit 1;
    update public.tour_revisions r set entry_scene_id = v_entry where r.id = v_draft.id;
  end if;
  delete from public.tour_scenes s where s.tour_revision_id = v_draft.id and s.scene_id = p_scene_id;
  perform private.compact_tour_scenes(v_draft.id);

  return query select v_draft.id, v_draft.edit_count, v_entry;
end;
$$;

-- Sets the one entry scene: a scene of this draft.
create function public.set_tour_entry_scene(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_expected_edit integer,
  p_scene_id uuid
)
returns table (revision_id uuid, edit_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft public.tour_revisions;
begin
  v_draft := private.tour_draft_for_edit(p_tenant_id, p_tour_id, p_expected_edit);
  if not exists (select 1 from public.tour_scenes s where s.tour_revision_id = v_draft.id and s.scene_id = p_scene_id) then
    raise exception 'the entry must be a scene of this tour' using errcode = 'PT404';
  end if;
  update public.tour_revisions r set entry_scene_id = p_scene_id where r.id = v_draft.id;
  return query select v_draft.id, v_draft.edit_count;
end;
$$;

-- Owners and admins publish the open draft: seal it and point the public at it.
create function public.publish_tour(p_tenant_id uuid, p_tour_id uuid, p_expected_edit integer)
returns table (revision_id uuid, revision_no integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tour public.tours;
  v_draft public.tour_revisions;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select t.* into v_tour from public.tours t
  where t.id = p_tour_id and t.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;
  if v_tour.draft_revision_id is null then
    raise exception 'there is no draft to publish' using errcode = 'PT409';
  end if;
  select r.* into v_draft from public.tour_revisions r where r.id = v_tour.draft_revision_id for update;
  if v_draft.edit_count is distinct from p_expected_edit then
    raise exception 'the draft changed meanwhile' using errcode = 'PT409';
  end if;

  if v_draft.entry_scene_id is null
     or not exists (select 1 from public.tour_scenes s where s.tour_revision_id = v_draft.id) then
    raise exception 'a tour needs scenes and an entry scene to be published'
      using errcode = '23514', hint = 'incomplete';
  end if;
  if exists (
    select 1 from public.tour_scenes s
    join public.asset_versions v on v.tenant_id = s.tenant_id and v.id = s.panorama_version_id
    where s.tour_revision_id = v_draft.id and v.status <> 'ready'
  ) then
    raise exception 'a panorama is not ready' using errcode = 'PT409', hint = 'media';
  end if;

  update public.tour_revisions r
  set state = 'sealed', sealed_at = now(), sealed_by = (select auth.uid())
  where r.id = v_draft.id;
  update public.tours t
  set published_revision_id = v_draft.id, draft_revision_id = null, published_at = now(), updated_at = now()
  where t.id = p_tour_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'tour.published', 'tour', p_tour_id, v_draft.revision_no, 'success',
          jsonb_build_object('revision_id', v_draft.id, 'previous_revision_id', v_tour.published_revision_id,
                             'scenes', (select count(*) from public.tour_scenes s where s.tour_revision_id = v_draft.id)));

  return query select v_draft.id, v_draft.revision_no;
end;
$$;

-- Owners and admins put an earlier sealed revision back in front of the public.
create function public.restore_tour_revision(p_tenant_id uuid, p_tour_id uuid, p_revision_id uuid)
returns table (revision_id uuid, revision_no integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tour public.tours;
  v_revision public.tour_revisions;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  select t.* into v_tour from public.tours t
  where t.id = p_tour_id and t.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;
  select r.* into v_revision from public.tour_revisions r
  where r.id = p_revision_id and r.tour_id = p_tour_id and r.state = 'sealed';
  if not found then
    raise exception 'only published revisions of this tour can be restored' using errcode = 'PT404';
  end if;
  if v_tour.published_revision_id = p_revision_id then
    raise exception 'this revision is already the published one' using errcode = 'PT409';
  end if;

  update public.tours t set published_revision_id = p_revision_id, published_at = now(), updated_at = now()
  where t.id = p_tour_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'tour.restored', 'tour', p_tour_id, v_revision.revision_no, 'success',
          jsonb_build_object('revision_id', p_revision_id, 'previous_revision_id', v_tour.published_revision_id));

  return query select v_revision.id, v_revision.revision_no;
end;
$$;

-- Discards the open draft of a tour that is already published.
create function public.discard_tour_draft(p_tenant_id uuid, p_tour_id uuid, p_expected_edit integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tour public.tours;
  v_draft public.tour_revisions;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);
  select t.* into v_tour from public.tours t
  where t.id = p_tour_id and t.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;
  if v_tour.draft_revision_id is null then
    raise exception 'there is no draft to discard' using errcode = 'PT409';
  end if;
  if v_tour.published_revision_id is null then
    raise exception 'a tour that was never published keeps its draft' using errcode = 'PT409', hint = 'never_published';
  end if;
  select r.* into v_draft from public.tour_revisions r where r.id = v_tour.draft_revision_id for update;
  if v_draft.edit_count is distinct from p_expected_edit then
    raise exception 'the draft changed meanwhile' using errcode = 'PT409';
  end if;

  update public.tours t set draft_revision_id = null, updated_at = now() where t.id = p_tour_id;
  update public.tour_revisions r set entry_scene_id = null where r.id = v_draft.id;
  delete from public.tour_revisions r where r.id = v_draft.id;
end;
$$;

-- ── Reads for members ───────────────────────────────────────────────────────

-- The municipality's tours with what each belongs to.
create function public.list_tenant_tours(p_tenant_id uuid)
returns table (
  tour_id           uuid,
  content_id        uuid,
  content_kind      public.content_kind,
  content_slug      text,
  content_title     text,
  content_published boolean,
  status            text,
  scenes            integer,
  updated_at        timestamptz,
  published_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  return query
  select
    t.id, i.id, i.kind, i.slug,
    coalesce(cd.title, cp.title),
    i.published_revision_id is not null,
    case
      when t.published_revision_id is null then 'draft'
      when t.draft_revision_id is null then 'published'
      else 'changed'
    end,
    (select count(*)::integer from public.tour_scenes s
     where s.tour_revision_id = coalesce(t.draft_revision_id, t.published_revision_id)),
    t.updated_at, t.published_at
  from public.tours t
  join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
  left join public.content_revisions cd on cd.id = i.draft_revision_id
  left join public.content_revisions cp on cp.id = i.published_revision_id
  where t.tenant_id = p_tenant_id
  order by coalesce(cd.title, cp.title);
end;
$$;

-- Everything the editor needs: the tour, its draft and published revisions, its history.
create function public.tour_editor(p_tenant_id uuid, p_tour_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]) then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;
  select jsonb_build_object(
    'tourId', t.id,
    'content', jsonb_build_object(
      'contentId', i.id, 'kind', i.kind, 'slug', i.slug,
      'title', coalesce(cd.title, cp.title), 'published', i.published_revision_id is not null
    ),
    'draft', case when t.draft_revision_id is null then 'null'::jsonb
                  else private.tour_revision_document(t.draft_revision_id) end,
    'published', case when t.published_revision_id is null then 'null'::jsonb
                      else private.tour_revision_document(t.published_revision_id) end,
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'revisionId', r.id, 'revisionNo', r.revision_no, 'sealedAt', r.sealed_at,
        'scenes', (select count(*) from public.tour_scenes s where s.tour_revision_id = r.id)
      ) order by r.revision_no desc)
      from public.tour_revisions r where r.tour_id = t.id and r.state = 'sealed'
    ), '[]'::jsonb)
  ) into v_result
  from public.tours t
  join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
  left join public.content_revisions cd on cd.id = i.draft_revision_id
  left join public.content_revisions cp on cp.id = i.published_revision_id
  where t.id = p_tour_id and t.tenant_id = p_tenant_id;
  if v_result is null then
    raise exception 'tour not found' using errcode = 'PT404';
  end if;
  return v_result;
end;
$$;

-- One revision of a tour of this tenant (to preview the history).
create function public.tour_revision_document(p_tenant_id uuid, p_revision_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[])
     or not exists (select 1 from public.tour_revisions r where r.id = p_revision_id and r.tenant_id = p_tenant_id) then
    raise exception 'revision not found' using errcode = 'PT404';
  end if;
  return private.tour_revision_document(p_revision_id);
end;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

revoke all on function public.create_tour(uuid, uuid) from public, anon, authenticated;
revoke all on function public.add_tour_scene(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.update_tour_scene(uuid, uuid, integer, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.move_tour_scene(uuid, uuid, integer, uuid, integer) from public, anon, authenticated;
revoke all on function public.remove_tour_scene(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.set_tour_entry_scene(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.publish_tour(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.restore_tour_revision(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.discard_tour_draft(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.list_tenant_tours(uuid) from public, anon, authenticated;
revoke all on function public.tour_editor(uuid, uuid) from public, anon, authenticated;
revoke all on function public.tour_revision_document(uuid, uuid) from public, anon, authenticated;

grant execute on function public.create_tour(uuid, uuid) to authenticated;
grant execute on function public.add_tour_scene(uuid, uuid, integer, uuid, text) to authenticated;
grant execute on function public.update_tour_scene(uuid, uuid, integer, uuid, jsonb) to authenticated;
grant execute on function public.move_tour_scene(uuid, uuid, integer, uuid, integer) to authenticated;
grant execute on function public.remove_tour_scene(uuid, uuid, integer, uuid) to authenticated;
grant execute on function public.set_tour_entry_scene(uuid, uuid, integer, uuid) to authenticated;
grant execute on function public.publish_tour(uuid, uuid, integer) to authenticated;
grant execute on function public.restore_tour_revision(uuid, uuid, uuid) to authenticated;
grant execute on function public.discard_tour_draft(uuid, uuid, integer) to authenticated;
grant execute on function public.list_tenant_tours(uuid) to authenticated;
grant execute on function public.tour_editor(uuid, uuid) to authenticated;
grant execute on function public.tour_revision_document(uuid, uuid) to authenticated;
