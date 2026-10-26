-- ─────────────────────────────────────────────────────────────────────────────
-- P4 · Paso 3: publishing a tour makes its media public and seals a manifest (ADR-030).
--
--   * Before a tour revision is sealed, every file it uses is copied to the public bucket
--     and the version is marked published (the server does it, then calls publish_tour):
--     the panoramas' preview, image and tiles, the points' photos, and the 3D models with
--     their poster. publish_tour now REQUIRES them published, not only ready.
--   * The sealed revision stores its public manifest: scenes (with the public folder of
--     each panorama), points and what they lead to. Visitors read that snapshot, never the
--     editor's tables (FUN-02: one revision, only what it uses). "Go to another tour"
--     keeps the destination's content id; the portal resolves it when reading.
--   * Anonymous reads: portal_tour (one tour, by the kind and address of its destination
--     or event) and portal_tour_index (the published tours, for the general tour).
--     Only active tenants, published content and published tours; an ended event keeps its
--     tour page but leaves the index.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

-- The public bucket also serves the optimized models (up to 15 MB, ADR-026).
update storage.buckets
set file_size_limit = 15728640,
    allowed_mime_types = array['image/webp', 'image/png', 'model/gltf-binary']
where id = 'media-public';

alter table public.tour_revisions add column manifest jsonb;
alter table public.tour_revisions
  add constraint tour_revisions_manifest_object check (
    manifest is null or (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 1048576)
  );

-- ── The public manifest of a revision ──────────────────────────────────────

-- Version prefix of a media version: {tenant}/{asset}/{version}/
create function private.version_prefix(p_version public.asset_versions)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_version.tenant_id::text || '/' || p_version.asset_id::text || '/' || p_version.version::text || '/';
$$;

revoke all on function private.version_prefix(public.asset_versions) from public;

create function private.tour_public_manifest(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'revisionNo', r.revision_no,
    'entrySceneId', r.entry_scene_id,
    'scenes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sceneId', s.scene_id,
        'title', s.title,
        'description', s.description,
        'initialView', jsonb_build_object('yaw', s.initial_yaw, 'pitch', s.initial_pitch, 'fov', s.initial_fov),
        'panorama', jsonb_build_object(
          'folder', private.version_prefix(pv) || 'panorama/',
          'width', pv.width,
          'height', pv.height,
          'preview', pv.manifest -> 'preview',
          'image', pv.manifest -> 'image',
          'tiles', pv.manifest -> 'tiles'
        ),
        'hotspots', coalesce((
          select jsonb_agg(jsonb_build_object(
            'hotspotId', h.hotspot_id,
            'kind', h.kind,
            'position', jsonb_build_object('yaw', h.yaw, 'pitch', h.pitch),
            'title', h.title,
            'body', h.body,
            'gallery', coalesce((
              select jsonb_agg(jsonb_build_object(
                'assetId', gv.asset_id, 'version', gv.version, 'alt', g.alt_text,
                'width', gv.width, 'height', gv.height
              ) order by g.position)
              from public.tour_hotspot_images g
              join public.asset_versions gv on gv.tenant_id = g.tenant_id and gv.id = g.asset_version_id
              where g.tour_revision_id = h.tour_revision_id and g.hotspot_id = h.hotspot_id
            ), '[]'::jsonb),
            'targetSceneId', h.target_scene_id,
            'model', case when h.model_version_id is null then 'null'::jsonb else (
              select jsonb_build_object(
                'folder', private.version_prefix(mv) || 'model/',
                'file', mv.manifest #>> '{model,file}',
                'bytes', (mv.manifest #>> '{model,bytes}')::integer,
                'weight', mv.manifest ->> 'weight',
                'poster', mv.manifest -> 'poster'
              )
              from public.asset_versions mv where mv.tenant_id = h.tenant_id and mv.id = h.model_version_id
            ) end,
            'targetContentId', h.target_content_id
          ) order by h.created_at, h.hotspot_id)
          from public.tour_hotspots h
          where h.tour_revision_id = s.tour_revision_id and h.scene_id = s.scene_id
        ), '[]'::jsonb)
      ) order by s.position)
      from public.tour_scenes s
      join public.asset_versions pv on pv.tenant_id = s.tenant_id and pv.id = s.panorama_version_id
      where s.tour_revision_id = r.id
    ), '[]'::jsonb)
  )
  from public.tour_revisions r
  where r.id = p_revision_id;
$$;

revoke all on function private.tour_public_manifest(uuid) from public;

-- Revisions sealed before this step get their manifest (only the snapshot is written: the
-- trigger that protects sealed revisions is paused for this one statement).
alter table public.tour_revisions disable trigger tour_revisions_protect_sealed;
update public.tour_revisions r
set manifest = private.tour_public_manifest(r.id)
where r.state = 'sealed' and r.manifest is null;
alter table public.tour_revisions enable trigger tour_revisions_protect_sealed;

-- A sealed revision always has its manifest from now on.
alter table public.tour_revisions
  add constraint tour_revisions_sealed_has_manifest check (state <> 'sealed' or manifest is not null);

-- The editor document also says whether each panorama and model is public already (the
-- server copies only what is missing).
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
          'width', v.width, 'height', v.height, 'manifest', v.manifest,
          'published', v.published_at is not null
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
                                        'manifest', mv.manifest, 'published', mv.published_at is not null)
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

-- ── Publishing ──────────────────────────────────────────────────────────────

-- Same checks as before, but every medium must be PUBLIC already, and the sealed revision
-- keeps its manifest.
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
    select 1 from public.tour_hotspots h
    join public.asset_versions v on v.tenant_id = h.tenant_id and v.id = h.model_version_id
    where h.tour_revision_id = v_draft.id
      and (v.status <> 'ready' or jsonb_typeof(v.manifest -> 'poster') is distinct from 'object')
  ) then
    raise exception 'a 3D model has no poster yet' using errcode = 'PT409', hint = 'poster';
  end if;
  if exists (
    select 1 from public.tour_scenes s
    join public.asset_versions v on v.tenant_id = s.tenant_id and v.id = s.panorama_version_id
    where s.tour_revision_id = v_draft.id and v.published_at is null
  ) or exists (
    select 1 from public.tour_hotspot_images i
    join public.asset_versions v on v.tenant_id = i.tenant_id and v.id = i.asset_version_id
    where i.tour_revision_id = v_draft.id and v.published_at is null
  ) or exists (
    select 1 from public.tour_hotspots h
    join public.asset_versions v on v.tenant_id = h.tenant_id and v.id = h.model_version_id
    where h.tour_revision_id = v_draft.id and v.published_at is null
  ) then
    raise exception 'a panorama, photo or model is not public yet' using errcode = 'PT409', hint = 'media';
  end if;

  update public.tour_revisions r
  set state = 'sealed', sealed_at = now(), sealed_by = (select auth.uid()),
      manifest = private.tour_public_manifest(v_draft.id)
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

-- ── Anonymous reads for portals ─────────────────────────────────────────────

-- Whether a content item is visible to visitors with its tour: active tenant, published
-- content and published tour. Events that ended keep their tour (like their page).
create function private.visible_tour(p_tenant_id uuid)
returns table (
  tour_id      uuid,
  content_id   uuid,
  kind         public.content_kind,
  slug         text,
  title        text,
  revision_id  uuid,
  published_at timestamptz,
  ended        boolean,
  latitude     double precision,
  longitude    double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, i.id, i.kind, i.slug, cr.title, t.published_revision_id, t.published_at,
         i.kind = 'event' and coalesce(
           private.event_ends_at(cr.ends_local, cr.all_day, tn.timezone) <= now(), false
         ),
         cr.latitude, cr.longitude
  from public.tours t
  join public.tenants tn on tn.id = t.tenant_id and tn.status = 'active'
  join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
  join public.content_revisions cr on cr.id = i.published_revision_id and cr.state = 'sealed'
  where t.tenant_id = p_tenant_id and t.published_revision_id is not null;
$$;

revoke all on function private.visible_tour(uuid) from public;

-- One tour, by its destination's or event's kind and address. "Go to another tour" points
-- come with their resolved destination (null when it has no visible tour: hidden).
create function public.portal_tour(p_tenant_id uuid, p_kind public.content_kind, p_slug text)
returns table (
  kind         public.content_kind,
  slug         text,
  title        text,
  revision_no  integer,
  published_at timestamptz,
  ended        boolean,
  manifest     jsonb,
  targets      jsonb
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
           where o.content_id in (
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

-- The general tour's index: the visible tours (no ended events), with their entry scene's
-- preview, so the general tour only downloads the tour someone opens.
create function public.portal_tour_index(p_tenant_id uuid)
returns table (
  kind         public.content_kind,
  slug         text,
  title        text,
  scenes       integer,
  entry_title  text,
  entry_folder text,
  entry_preview jsonb,
  latitude     double precision,
  longitude    double precision,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.kind, v.slug, v.title,
         jsonb_array_length(r.manifest -> 'scenes'),
         e ->> 'title', e #>> '{panorama,folder}', e #> '{panorama,preview}',
         v.latitude, v.longitude, v.published_at
  from private.visible_tour(p_tenant_id) v
  join public.tour_revisions r on r.id = v.revision_id
  left join lateral (
    select sc from jsonb_array_elements(r.manifest -> 'scenes') sc
    where sc ->> 'sceneId' = r.manifest ->> 'entrySceneId'
  ) entry (e) on true
  where not v.ended
  order by v.kind, v.title;
$$;

revoke all on function public.portal_tour(uuid, public.content_kind, text) from public, anon, authenticated;
revoke all on function public.portal_tour_index(uuid) from public, anon, authenticated;
grant execute on function public.portal_tour(uuid, public.content_kind, text) to anon, authenticated;
grant execute on function public.portal_tour_index(uuid) to anon, authenticated;
