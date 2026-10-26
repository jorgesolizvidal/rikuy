-- ─────────────────────────────────────────────────────────────────────────────
-- P4 · Paso 2: hotspots of a tour's scenes (pilot schema table 10, ADR-029).
--
--   * tour_hotspots: a point of a scene (yaw/pitch in radians, as the viewer) with a kind:
--       info  — title, rich text (AST) and an optional gallery of photos with alt text;
--       scene — goes to another scene of the SAME revision;
--       model — opens a ready 3D model of the municipality;
--       tour  — goes to another destination's or event's tour ("ir a otro recorrido"); it
--               points at the content, and the portal resolves it to that tour's published
--               entry (hidden while there is none).
--     Fields of other kinds stay null (checked). hotspot_id is stable across revisions.
--   * tour_hotspot_images: the gallery of an info hotspot (content images, alt required).
--   * Edits are intent RPCs with the draft's edit number; a change sends only what changes
--     and the kind never changes (RC-01). Removing a scene removes its hotspots and the
--     arrows that led to it.
-- Expand-only.
-- Error codes: 42501 forbidden · 23514 invalid · PT404 unknown · PT409 conflict/state.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.tour_hotspot_kind as enum ('info', 'scene', 'model', 'tour');

create table public.tour_hotspots (
  tenant_id          uuid not null,
  tour_revision_id   uuid not null,
  hotspot_id         uuid not null,
  scene_id           uuid not null,
  kind               public.tour_hotspot_kind not null,
  yaw                double precision not null,
  pitch              double precision not null,
  title              text not null,
  body               jsonb not null default '[]'::jsonb,
  target_scene_id    uuid,
  model_version_id   uuid,
  target_content_id  uuid,
  created_at         timestamptz not null default now(),

  constraint tour_hotspots_pkey primary key (tenant_id, tour_revision_id, hotspot_id),
  constraint tour_hotspots_scene_fkey foreign key (tenant_id, tour_revision_id, scene_id)
    references public.tour_scenes (tenant_id, tour_revision_id, scene_id) on delete cascade,
  constraint tour_hotspots_target_scene_fkey foreign key (tenant_id, tour_revision_id, target_scene_id)
    references public.tour_scenes (tenant_id, tour_revision_id, scene_id) on delete cascade,
  constraint tour_hotspots_model_fkey foreign key (tenant_id, model_version_id)
    references public.asset_versions (tenant_id, id) on delete restrict,
  constraint tour_hotspots_target_content_fkey foreign key (tenant_id, target_content_id)
    references public.content_items (tenant_id, id) on delete restrict,
  constraint tour_hotspots_position check (
    yaw >= -pi() and yaw < pi() and pitch between -pi() / 2 and pi() / 2
  ),
  constraint tour_hotspots_title check (
    char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]' and title = btrim(title)
  ),
  constraint tour_hotspots_body check (jsonb_typeof(body) = 'array' and octet_length(body::text) <= 20000),
  -- Each kind carries exactly its own target.
  constraint tour_hotspots_kind_fields check (
    case kind
      when 'info' then target_scene_id is null and model_version_id is null and target_content_id is null
      when 'scene' then target_scene_id is not null and target_scene_id <> scene_id
                        and model_version_id is null and target_content_id is null and body = '[]'::jsonb
      when 'model' then model_version_id is not null and target_scene_id is null
                        and target_content_id is null and body = '[]'::jsonb
      when 'tour' then target_content_id is not null and target_scene_id is null
                       and model_version_id is null and body = '[]'::jsonb
    end
  )
);

create index tour_hotspots_scene_idx on public.tour_hotspots (tour_revision_id, scene_id);
create index tour_hotspots_model_idx on public.tour_hotspots (tenant_id, model_version_id) where model_version_id is not null;
create index tour_hotspots_target_content_idx on public.tour_hotspots (tenant_id, target_content_id) where target_content_id is not null;

create table public.tour_hotspot_images (
  tenant_id         uuid not null,
  tour_revision_id  uuid not null,
  hotspot_id        uuid not null,
  position          smallint not null,
  asset_version_id  uuid not null,
  alt_text          text not null,

  constraint tour_hotspot_images_pkey primary key (tenant_id, tour_revision_id, hotspot_id, position),
  constraint tour_hotspot_images_hotspot_fkey foreign key (tenant_id, tour_revision_id, hotspot_id)
    references public.tour_hotspots (tenant_id, tour_revision_id, hotspot_id) on delete cascade,
  constraint tour_hotspot_images_asset_fkey foreign key (tenant_id, asset_version_id)
    references public.asset_versions (tenant_id, id) on delete restrict,
  constraint tour_hotspot_images_position check (position between 0 and 11),
  constraint tour_hotspot_images_alt check (
    char_length(alt_text) between 1 and 200 and alt_text !~ '[[:cntrl:]]' and alt_text = btrim(alt_text)
  )
);

create index tour_hotspot_images_asset_idx on public.tour_hotspot_images (tenant_id, asset_version_id);

-- ── Integrity ───────────────────────────────────────────────────────────────

-- Hotspots (and their photos) of a sealed revision are immutable.
create function private.protect_sealed_tour_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision uuid := case when tg_op = 'INSERT' then new.tour_revision_id else old.tour_revision_id end;
begin
  if exists (select 1 from public.tour_revisions r where r.id = v_revision and r.state = 'sealed') then
    raise exception 'a sealed revision is immutable' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.protect_sealed_tour_child() from public;

create trigger tour_hotspots_protect_sealed
  before insert or update or delete on public.tour_hotspots
  for each row execute function private.protect_sealed_tour_child();
create trigger tour_hotspot_images_protect_sealed
  before insert or update or delete on public.tour_hotspot_images
  for each row execute function private.protect_sealed_tour_child();
create trigger tour_hotspots_forbid_tenant_change
  before update of tenant_id on public.tour_hotspots
  for each row execute function private.forbid_tenant_change();
create trigger tour_hotspot_images_forbid_tenant_change
  before update of tenant_id on public.tour_hotspot_images
  for each row execute function private.forbid_tenant_change();

revoke all on table public.tour_hotspots, public.tour_hotspot_images from anon, authenticated;
grant select on table public.tour_hotspots, public.tour_hotspot_images to authenticated;
alter table public.tour_hotspots enable row level security;
alter table public.tour_hotspot_images enable row level security;
create policy tour_hotspots_select_members
  on public.tour_hotspots for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));
create policy tour_hotspot_images_select_members
  on public.tour_hotspot_images for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- A ready 3D model of this tenant, or an error.
create function private.tour_model_version(p_tenant_id uuid, p_version_id uuid)
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
  where v.tenant_id = p_tenant_id and v.id = p_version_id and a.purpose = 'model' and v.status = 'ready';
  if v_id is null then
    raise exception 'the 3D model is not ready or not of this tenant' using errcode = '23514', hint = 'model';
  end if;
  return v_id;
end;
$$;

revoke all on function private.tour_model_version(uuid, uuid) from public;

-- Stores the gallery of an info hotspot (replaces it): [{assetId, version, alt}], ≤ 12.
create function private.save_hotspot_gallery(
  p_tenant_id uuid,
  p_revision_id uuid,
  p_hotspot_id uuid,
  p_gallery jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_image jsonb;
  v_position integer := 0;
begin
  if jsonb_typeof(p_gallery) <> 'array' or jsonb_array_length(p_gallery) > 12 then
    raise exception 'invalid gallery' using errcode = '23514', hint = 'gallery';
  end if;
  delete from public.tour_hotspot_images i
  where i.tour_revision_id = p_revision_id and i.hotspot_id = p_hotspot_id;
  for v_image in select value from jsonb_array_elements(p_gallery) loop
    if not private.is_valid_image_reference(v_image) then
      raise exception 'invalid gallery' using errcode = '23514', hint = 'gallery';
    end if;
    insert into public.tour_hotspot_images (tenant_id, tour_revision_id, hotspot_id, position, asset_version_id, alt_text)
    values (p_tenant_id, p_revision_id, p_hotspot_id, v_position,
            private.content_image_version(p_tenant_id, v_image, false), v_image ->> 'alt');
    v_position := v_position + 1;
  end loop;
end;
$$;

revoke all on function private.save_hotspot_gallery(uuid, uuid, uuid, jsonb) from public;

-- Checks and applies the target fields present in p (kind-specific), for insert or update.
create function private.apply_hotspot_fields(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_revision_id uuid,
  p_hotspot_id uuid,
  p jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hotspot public.tour_hotspots;
  v_position jsonb := p -> 'position';
  v_own_content uuid;
begin
  select h.* into v_hotspot from public.tour_hotspots h
  where h.tour_revision_id = p_revision_id and h.hotspot_id = p_hotspot_id;

  if p ? 'title' and not private.is_plain_line(p -> 'title', 1, 120) then
    raise exception 'invalid title' using errcode = '23514', hint = 'title';
  end if;
  if p ? 'position' and not (
    private.has_exact_keys(v_position, array['yaw', 'pitch'])
    and jsonb_typeof(v_position -> 'yaw') = 'number' and jsonb_typeof(v_position -> 'pitch') = 'number'
    and (v_position ->> 'yaw')::double precision >= -pi() and (v_position ->> 'yaw')::double precision < pi()
    and (v_position ->> 'pitch')::double precision between -pi() / 2 and pi() / 2
  ) then
    raise exception 'invalid position' using errcode = '23514', hint = 'position';
  end if;
  if p ? 'body' and (v_hotspot.kind <> 'info' or not private.is_valid_rich_text(p -> 'body')
                     or octet_length((p -> 'body')::text) > 20000) then
    raise exception 'invalid text' using errcode = '23514', hint = 'body';
  end if;
  if p ? 'gallery' and v_hotspot.kind <> 'info' then
    raise exception 'only information points have photos' using errcode = '23514', hint = 'gallery';
  end if;
  if p ? 'targetSceneId' and (
    v_hotspot.kind <> 'scene' or jsonb_typeof(p -> 'targetSceneId') <> 'string'
    or not exists (
      select 1 from public.tour_scenes s
      where s.tour_revision_id = p_revision_id and s.scene_id::text = p ->> 'targetSceneId'
        and s.scene_id <> v_hotspot.scene_id
    )
  ) then
    raise exception 'the target must be another scene of this tour' using errcode = '23514', hint = 'target';
  end if;
  if p ? 'modelVersionId' and (v_hotspot.kind <> 'model' or jsonb_typeof(p -> 'modelVersionId') <> 'string'
                               or (p ->> 'modelVersionId') !~ '^[0-9a-f-]{36}$') then
    raise exception 'invalid model' using errcode = '23514', hint = 'model';
  end if;
  if p ? 'targetContentId' then
    select t.content_id into v_own_content from public.tours t where t.id = p_tour_id;
    if v_hotspot.kind <> 'tour' or jsonb_typeof(p -> 'targetContentId') <> 'string'
       or (p ->> 'targetContentId') !~ '^[0-9a-f-]{36}$'
       or (p ->> 'targetContentId')::uuid = v_own_content
       or not exists (
         select 1 from public.content_items i where i.tenant_id = p_tenant_id and i.id = (p ->> 'targetContentId')::uuid
       ) then
      raise exception 'the target must be another destination or event of this municipality'
        using errcode = '23514', hint = 'target';
    end if;
  end if;

  update public.tour_hotspots h
  set title = case when p ? 'title' then p ->> 'title' else h.title end,
      yaw = case when p ? 'position' then (v_position ->> 'yaw')::double precision else h.yaw end,
      pitch = case when p ? 'position' then (v_position ->> 'pitch')::double precision else h.pitch end,
      body = case when p ? 'body' then p -> 'body' else h.body end,
      target_scene_id = case when p ? 'targetSceneId' then (p ->> 'targetSceneId')::uuid else h.target_scene_id end,
      model_version_id = case when p ? 'modelVersionId'
                              then private.tour_model_version(p_tenant_id, (p ->> 'modelVersionId')::uuid)
                              else h.model_version_id end,
      target_content_id = case when p ? 'targetContentId' then (p ->> 'targetContentId')::uuid else h.target_content_id end
  where h.tour_revision_id = p_revision_id and h.hotspot_id = p_hotspot_id;

  if p ? 'gallery' then
    perform private.save_hotspot_gallery(p_tenant_id, p_revision_id, p_hotspot_id, p -> 'gallery');
  end if;
end;
$$;

revoke all on function private.apply_hotspot_fields(uuid, uuid, uuid, uuid, jsonb) from public;

-- A new draft copies the published hotspots and photos too (same ids).
create or replace function private.tour_draft_for_edit(p_tenant_id uuid, p_tour_id uuid, p_expected_edit integer)
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
    insert into public.tour_hotspots (
      tenant_id, tour_revision_id, hotspot_id, scene_id, kind, yaw, pitch, title, body,
      target_scene_id, model_version_id, target_content_id, created_at
    )
    select h.tenant_id, v_draft.id, h.hotspot_id, h.scene_id, h.kind, h.yaw, h.pitch, h.title, h.body,
           h.target_scene_id, h.model_version_id, h.target_content_id, h.created_at
    from public.tour_hotspots h
    where h.tour_revision_id = v_tour.published_revision_id;
    insert into public.tour_hotspot_images (tenant_id, tour_revision_id, hotspot_id, position, asset_version_id, alt_text)
    select i.tenant_id, v_draft.id, i.hotspot_id, i.position, i.asset_version_id, i.alt_text
    from public.tour_hotspot_images i
    where i.tour_revision_id = v_tour.published_revision_id;
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

-- The revision document gains each scene's hotspots.
create or replace function private.tour_revision_document(p_revision_id uuid)
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
        ),
        'hotspots', coalesce((
          select jsonb_agg(jsonb_build_object(
            'hotspotId', h.hotspot_id,
            'kind', h.kind,
            'position', jsonb_build_object('yaw', h.yaw, 'pitch', h.pitch),
            'title', h.title,
            'body', h.body,
            'gallery', coalesce((
              select jsonb_agg(jsonb_build_object('assetId', gv.asset_id, 'version', gv.version, 'alt', g.alt_text)
                               order by g.position)
              from public.tour_hotspot_images g
              join public.asset_versions gv on gv.tenant_id = g.tenant_id and gv.id = g.asset_version_id
              where g.tour_revision_id = h.tour_revision_id and g.hotspot_id = h.hotspot_id
            ), '[]'::jsonb),
            'targetSceneId', h.target_scene_id,
            'model', case when h.model_version_id is null then 'null'::jsonb else (
              select jsonb_build_object('versionId', mv.id, 'assetId', mv.asset_id, 'version', mv.version,
                                        'manifest', mv.manifest)
              from public.asset_versions mv where mv.tenant_id = h.tenant_id and mv.id = h.model_version_id
            ) end,
            'target', case when h.target_content_id is null then 'null'::jsonb else (
              select jsonb_build_object(
                'contentId', i.id, 'kind', i.kind, 'slug', i.slug,
                'title', coalesce(cd.title, cp.title),
                'published', i.published_revision_id is not null,
                'tourPublished', exists (
                  select 1 from public.tours tt where tt.tenant_id = i.tenant_id and tt.content_id = i.id
                    and tt.published_revision_id is not null
                )
              )
              from public.content_items i
              left join public.content_revisions cd on cd.id = i.draft_revision_id
              left join public.content_revisions cp on cp.id = i.published_revision_id
              where i.tenant_id = h.tenant_id and i.id = h.target_content_id
            ) end
          ) order by h.created_at, h.hotspot_id)
          from public.tour_hotspots h
          where h.tour_revision_id = s.tour_revision_id and h.scene_id = s.scene_id
        ), '[]'::jsonb)
      ) order by s.position)
      from public.tour_scenes s
      join public.asset_versions v on v.tenant_id = s.tenant_id and v.id = s.panorama_version_id
      where s.tour_revision_id = r.id
    ), '[]'::jsonb)
  )
  from public.tour_revisions r
  where r.id = p_revision_id;
$$;

-- Publishing also needs every point's media ready: models with their poster (visitors see
-- it while the model loads), photos ready. "Ir a otro recorrido" never blocks: it is
-- hidden while its destination has no published tour.
create or replace function public.publish_tour(p_tenant_id uuid, p_tour_id uuid, p_expected_edit integer)
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
  ) or exists (
    select 1 from public.tour_hotspot_images i
    join public.asset_versions v on v.tenant_id = i.tenant_id and v.id = i.asset_version_id
    where i.tour_revision_id = v_draft.id and v.status <> 'ready'
  ) then
    raise exception 'a panorama or photo is not ready' using errcode = 'PT409', hint = 'media';
  end if;
  if exists (
    select 1 from public.tour_hotspots h
    join public.asset_versions v on v.tenant_id = h.tenant_id and v.id = h.model_version_id
    where h.tour_revision_id = v_draft.id
      and (v.status <> 'ready' or jsonb_typeof(v.manifest -> 'poster') is distinct from 'object')
  ) then
    raise exception 'a 3D model has no poster yet' using errcode = 'PT409', hint = 'poster';
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
                             'scenes', (select count(*) from public.tour_scenes s where s.tour_revision_id = v_draft.id),
                             'hotspots', (select count(*) from public.tour_hotspots h where h.tour_revision_id = v_draft.id)));

  return query select v_draft.id, v_draft.revision_no;
end;
$$;

-- ── Intent RPCs ─────────────────────────────────────────────────────────────

-- Adds a point to a scene: {kind, title, position{yaw,pitch}} plus its kind's target
-- (targetSceneId | modelVersionId | targetContentId) and, for info, body and gallery.
create function public.add_tour_hotspot(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_expected_edit integer,
  p_scene_id uuid,
  p_hotspot jsonb
)
returns table (revision_id uuid, edit_count integer, hotspot_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_draft public.tour_revisions;
  v_hotspot uuid := gen_random_uuid();
  v_kind public.tour_hotspot_kind;
  v_required text;
begin
  v_draft := private.tour_draft_for_edit(p_tenant_id, p_tour_id, p_expected_edit);
  if not exists (select 1 from public.tour_scenes s where s.tour_revision_id = v_draft.id and s.scene_id = p_scene_id) then
    raise exception 'scene not found' using errcode = 'PT404';
  end if;
  if p_hotspot is null or jsonb_typeof(p_hotspot) <> 'object'
     or (p_hotspot ->> 'kind') is null or (p_hotspot ->> 'kind') not in ('info', 'scene', 'model', 'tour') then
    raise exception 'invalid point' using errcode = '23514', hint = 'kind';
  end if;
  v_kind := (p_hotspot ->> 'kind')::public.tour_hotspot_kind;
  v_required := case v_kind when 'scene' then 'targetSceneId' when 'model' then 'modelVersionId'
                            when 'tour' then 'targetContentId' else null end;
  if not private.has_exact_keys(
       p_hotspot,
       array['kind', 'title', 'position'] || case when v_required is null then '{}'::text[] else array[v_required] end,
       case when v_kind = 'info' then array['body', 'gallery'] else '{}'::text[] end
     )
     or not private.is_plain_line(p_hotspot -> 'title', 1, 120) then
    raise exception 'invalid point' using errcode = '23514', hint = 'title';
  end if;
  if (select count(*) from public.tour_hotspots h where h.tour_revision_id = v_draft.id and h.scene_id = p_scene_id) >= 50 then
    raise exception 'a scene has at most 50 points' using errcode = '23514', hint = 'limit';
  end if;

  -- The kind's target first (the row is never stored without one).
  if v_kind = 'scene' and not exists (
    select 1 from public.tour_scenes s
    where s.tour_revision_id = v_draft.id and s.scene_id::text = p_hotspot ->> 'targetSceneId'
      and s.scene_id <> p_scene_id
  ) then
    raise exception 'the target must be another scene of this tour' using errcode = '23514', hint = 'target';
  end if;
  if v_kind = 'model' and coalesce(p_hotspot ->> 'modelVersionId', '') !~ '^[0-9a-f-]{36}$' then
    raise exception 'invalid model' using errcode = '23514', hint = 'model';
  end if;
  if v_kind = 'tour' and (
    coalesce(p_hotspot ->> 'targetContentId', '') !~ '^[0-9a-f-]{36}$'
    or not exists (
      select 1 from public.content_items i
      where i.tenant_id = p_tenant_id and i.id = (p_hotspot ->> 'targetContentId')::uuid
        and i.id <> (select t.content_id from public.tours t where t.id = p_tour_id)
    )
  ) then
    raise exception 'the target must be another destination or event of this municipality'
      using errcode = '23514', hint = 'target';
  end if;

  insert into public.tour_hotspots (
    tenant_id, tour_revision_id, hotspot_id, scene_id, kind, yaw, pitch, title,
    target_scene_id, model_version_id, target_content_id
  )
  values (
    p_tenant_id, v_draft.id, v_hotspot, p_scene_id, v_kind, 0, 0, 'x',
    case when v_kind = 'scene' then (p_hotspot ->> 'targetSceneId')::uuid end,
    case when v_kind = 'model' then private.tour_model_version(p_tenant_id, (p_hotspot ->> 'modelVersionId')::uuid) end,
    case when v_kind = 'tour' then (p_hotspot ->> 'targetContentId')::uuid end
  );
  -- Title, position and (info) text and photos, with the same checks as a change.
  perform private.apply_hotspot_fields(
    p_tenant_id, p_tour_id, v_draft.id, v_hotspot,
    p_hotspot - 'kind' - 'targetSceneId' - 'modelVersionId' - 'targetContentId'
  );

  return query select v_draft.id, v_draft.edit_count, v_hotspot;
end;
$$;

-- Changes only the fields present (title, position, body, gallery, the kind's target).
-- The kind never changes: to change it, remove the point and add another (RC-01).
create function public.update_tour_hotspot(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_expected_edit integer,
  p_hotspot_id uuid,
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
begin
  v_draft := private.tour_draft_for_edit(p_tenant_id, p_tour_id, p_expected_edit);
  if not exists (select 1 from public.tour_hotspots h where h.tour_revision_id = v_draft.id and h.hotspot_id = p_hotspot_id) then
    raise exception 'point not found' using errcode = 'PT404';
  end if;
  if p_changes is null or p_changes = '{}'::jsonb
     or not private.has_exact_keys(p_changes, '{}',
       array['title', 'position', 'body', 'gallery', 'targetSceneId', 'modelVersionId', 'targetContentId']) then
    raise exception 'invalid changes' using errcode = '23514', hint = 'shape';
  end if;
  perform private.apply_hotspot_fields(p_tenant_id, p_tour_id, v_draft.id, p_hotspot_id, p_changes);
  return query select v_draft.id, v_draft.edit_count;
end;
$$;

create function public.remove_tour_hotspot(
  p_tenant_id uuid,
  p_tour_id uuid,
  p_expected_edit integer,
  p_hotspot_id uuid
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
  delete from public.tour_hotspots h where h.tour_revision_id = v_draft.id and h.hotspot_id = p_hotspot_id;
  if not found then
    raise exception 'point not found' using errcode = 'PT404';
  end if;
  return query select v_draft.id, v_draft.edit_count;
end;
$$;

-- What a point can lead to: the municipality's destinations and events (but this tour's
-- own), with whether each has a published tour.
create function public.tour_hotspot_targets(p_tenant_id uuid, p_tour_id uuid)
returns table (
  content_id     uuid,
  kind           public.content_kind,
  title          text,
  published      boolean,
  tour_published boolean
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
  select i.id, i.kind, coalesce(cd.title, cp.title), i.published_revision_id is not null,
         exists (select 1 from public.tours t where t.tenant_id = i.tenant_id and t.content_id = i.id
                 and t.published_revision_id is not null)
  from public.content_items i
  left join public.content_revisions cd on cd.id = i.draft_revision_id
  left join public.content_revisions cp on cp.id = i.published_revision_id
  where i.tenant_id = p_tenant_id
    and i.id is distinct from (select t.content_id from public.tours t where t.id = p_tour_id and t.tenant_id = p_tenant_id)
  order by i.kind, coalesce(cd.title, cp.title);
end;
$$;

revoke all on function public.add_tour_hotspot(uuid, uuid, integer, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.update_tour_hotspot(uuid, uuid, integer, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.remove_tour_hotspot(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.tour_hotspot_targets(uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_tour_hotspot(uuid, uuid, integer, uuid, jsonb) to authenticated;
grant execute on function public.update_tour_hotspot(uuid, uuid, integer, uuid, jsonb) to authenticated;
grant execute on function public.remove_tour_hotspot(uuid, uuid, integer, uuid) to authenticated;
grant execute on function public.tour_hotspot_targets(uuid, uuid) to authenticated;
