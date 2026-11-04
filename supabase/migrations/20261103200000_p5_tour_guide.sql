-- P5 · Paso 5 — the assistant as a guide inside a 360° tour (ADR-040). Expand only.
--
--   ai_api.tour_context: for the AI role only (rikuy_ai). Given the page's destination or
--   event (kind + slug) and, optionally, the scene and the point the visitor has open, it
--   resolves them against the CURRENTLY PUBLISHED tour of that item, in an online
--   municipality, and returns:
--     * what was found: the tour, the scene (the requested one when it belongs to that
--       published tour; otherwise the entry scene, with the reason) and the point (only
--       when it belongs to that scene);
--     * passages, in the same shape as the search: the point's text first, then the
--       scene's, then the scene's other points (up to 3), and the first sections of the
--       published destination or event (up to 2).
--   The browser only names IDs: no text it sends ever reaches the model as context, and an
--   ID of another tour, scene, revision or municipality is ignored (RC-05).

create function ai_api.tour_context(
  p_tenant_id uuid,
  p_kind text,
  p_slug text,
  p_scene_id uuid,
  p_hotspot_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.content_items%rowtype;
  v_content public.content_revisions%rowtype;
  v_tour public.tours%rowtype;
  v_revision public.tour_revisions%rowtype;
  v_scene jsonb;
  v_hotspot jsonb;
  v_scene_status text;
  v_hotspot_status text;
  v_ended boolean;
  v_passages jsonb;
begin
  if p_kind not in ('destination', 'event') then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id and t.status = 'active') then
    return jsonb_build_object('status', 'not_found');
  end if;

  select i.* into v_item
  from public.content_items i
  where i.tenant_id = p_tenant_id and i.kind = p_kind::public.content_kind and i.slug = p_slug
    and i.published_revision_id is not null;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select r.* into v_content
  from public.content_revisions r
  where r.id = v_item.published_revision_id and r.state = 'sealed';
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select t.* into v_tour
  from public.tours t
  where t.tenant_id = p_tenant_id and t.content_id = v_item.id and t.published_revision_id is not null;
  if not found then
    return jsonb_build_object('status', 'no_tour');
  end if;
  select tr.* into v_revision
  from public.tour_revisions tr
  where tr.id = v_tour.published_revision_id and tr.state = 'sealed' and tr.manifest is not null;
  if not found then
    return jsonb_build_object('status', 'no_tour');
  end if;

  -- The scene: the requested one only if this published tour has it; else the entry.
  if p_scene_id is not null then
    select s into v_scene
    from jsonb_array_elements(v_revision.manifest -> 'scenes') s
    where s ->> 'sceneId' = p_scene_id::text;
  end if;
  v_scene_status := case
    when p_scene_id is null then 'entry'
    when v_scene is not null then 'requested'
    else 'unknown'
  end;
  if v_scene is null then
    select s into v_scene
    from jsonb_array_elements(v_revision.manifest -> 'scenes') s
    where s ->> 'sceneId' = v_revision.manifest ->> 'entrySceneId';
  end if;
  if v_scene is null then
    return jsonb_build_object('status', 'no_tour');
  end if;

  -- The point: only one of that scene.
  if p_hotspot_id is not null then
    select h into v_hotspot
    from jsonb_array_elements(v_scene -> 'hotspots') h
    where h ->> 'hotspotId' = p_hotspot_id::text;
  end if;
  v_hotspot_status := case
    when p_hotspot_id is null then 'none'
    when v_hotspot is not null then 'requested'
    else 'unknown'
  end;

  v_ended := v_item.kind = 'event' and coalesce(
    private.event_ends_at(v_content.ends_local, v_content.all_day,
      (select tn.timezone from public.tenants tn where tn.id = p_tenant_id)) <= now(),
    false);

  with scene_chunks as (
    select c.*, 'tour'::text as source, v_tour.id as source_id, v_revision.revision_no as source_version,
           case
             when v_hotspot is not null and c.hotspot_id = (v_hotspot ->> 'hotspotId')::uuid then 0
             when c.hotspot_id is null then 1
             else 2
           end as rank
    from public.knowledge_chunks c
    where c.tenant_id = p_tenant_id
      and c.tour_revision_id = v_revision.id
      and c.scene_id = (v_scene ->> 'sceneId')::uuid
    order by rank, c.chunk_no
    limit 3
  ),
  place_chunks as (
    select c.*, 'content'::text as source, v_item.id as source_id, v_content.revision_no as source_version,
           3 as rank
    from public.knowledge_chunks c
    where c.tenant_id = p_tenant_id
      and c.content_revision_id = v_content.id
    order by c.chunk_no
    limit 2
  ),
  chosen as (
    select * from scene_chunks
    union all
    select * from place_chunks
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'chunk_id', x.id,
           'source', x.source,
           'source_id', x.source_id,
           'source_version', x.source_version,
           'kind', v_item.kind,
           'slug', v_item.slug,
           'title', x.title,
           'heading', x.heading,
           'body', x.body,
           'page_from', x.page_from,
           'page_to', x.page_to,
           'scene_id', x.scene_id,
           'hotspot_id', x.hotspot_id,
           'ended', v_ended,
           'score', 0
         ) order by x.rank, x.chunk_no), '[]'::jsonb)
  into v_passages
  from chosen x;

  return jsonb_build_object(
    'status', 'ok',
    'tour', jsonb_build_object('kind', v_item.kind, 'slug', v_item.slug, 'title', v_content.title),
    'scene', jsonb_build_object(
      'sceneId', v_scene ->> 'sceneId',
      'title', v_scene ->> 'title',
      'entry', (v_scene ->> 'sceneId') = (v_revision.manifest ->> 'entrySceneId'),
      'status', v_scene_status),
    'hotspot', case when v_hotspot is null then null else jsonb_build_object(
      'hotspotId', v_hotspot ->> 'hotspotId',
      'kind', v_hotspot ->> 'kind',
      'title', v_hotspot ->> 'title') end,
    'hotspotStatus', v_hotspot_status,
    'ended', v_ended,
    'passages', v_passages
  );
end;
$$;

revoke all on function ai_api.tour_context(uuid, text, text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function ai_api.tour_context(uuid, text, text, uuid, uuid) to rikuy_ai;
