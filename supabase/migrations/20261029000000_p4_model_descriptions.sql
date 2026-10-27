-- P4 · Paso 6 — a description for 3D model points (ADR-033). Expand only.
--
-- A model point opens a 3D viewer (a canvas): its text alternative is the description the
-- municipality writes, in the same limited rich text as information points. Optional, so
-- every model point already published stays valid; the panel asks for it. The sealed
-- manifest already carries every point's `body`, so the portal reads it with no change here.

-- The table: a model point may now carry text (scene and tour points still may not).
alter table public.tour_hotspots drop constraint tour_hotspots_kind_fields;
alter table public.tour_hotspots add constraint tour_hotspots_kind_fields check (
  case kind
    when 'info' then target_scene_id is null and model_version_id is null and target_content_id is null
    when 'scene' then target_scene_id is not null and target_scene_id <> scene_id
                      and model_version_id is null and target_content_id is null and body = '[]'::jsonb
    when 'model' then model_version_id is not null and target_scene_id is null
                      and target_content_id is null
    when 'tour' then target_content_id is not null and target_scene_id is null
                     and model_version_id is null and body = '[]'::jsonb
  end
);

-- The field checks shared by adding and changing a point: text for information and model
-- points (photos stay for information points only).
create or replace function private.apply_hotspot_fields(
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
  if p ? 'body' and (v_hotspot.kind not in ('info', 'model') or not private.is_valid_rich_text(p -> 'body')
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

-- Adding a point: a model point may bring its description (body) too.
create or replace function public.add_tour_hotspot(
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
       case v_kind when 'info' then array['body', 'gallery'] when 'model' then array['body'] else '{}'::text[] end
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
