-- C0 · Paso 2 — replacing and deleting panoramas and 3D models (ADR-048). Expand only.
--
--   * Replacing uploads a new version of the same asset (version N + 1), processed by the
--     same pipeline. Nothing changes for visitors: once it is ready, «use it in the tours»
--     puts it in the draft of every tour whose working revision uses an older version, and
--     visitors see it when the tour is published (like any other change).
--   * Deleting is only possible for a panorama or model that no tour revision (draft,
--     published or history) has ever used: the history can always be restored. It frees the
--     quota at once and the runner removes the files (the media.remove_unused job).
--   * media_asset_uses tells the panel where each one is used, and why it cannot be deleted.
--   * The poster of a model can also be a photo (same RPC as the viewer's capture: nothing
--     changes in the database for it).

-- ── Schema ──────────────────────────────────────────────────────────────────

alter table public.assets
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id) on delete set null;

create function private.deleted_media_reason()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Borrado por el municipio.'::text;
$$;

revoke all on function private.deleted_media_reason() from public;

-- Every tour revision that uses a version of the asset (scenes for a panorama, points for a
-- model), with what that revision is now for the tour.
create function private.media_asset_uses(p_tenant_id uuid, p_asset_id uuid)
returns table (tour_id uuid, revision_id uuid, scope text, version_id uuid, version integer)
language sql
stable
security definer
set search_path = ''
as $$
  with used as (
    select s.tour_revision_id as revision_id, s.panorama_version_id as version_id
    from public.tour_scenes s
    where s.tenant_id = p_tenant_id
    union
    select h.tour_revision_id, h.model_version_id
    from public.tour_hotspots h
    where h.tenant_id = p_tenant_id and h.model_version_id is not null
  )
  select t.id, r.id,
         case
           when r.id = t.draft_revision_id then 'draft'
           when r.id = t.published_revision_id then 'published'
           else 'history'
         end,
         v.id, v.version
  from used u
  join public.asset_versions v on v.id = u.version_id and v.tenant_id = p_tenant_id
  join public.tour_revisions r on r.id = u.revision_id and r.tenant_id = p_tenant_id
  join public.tours t on t.id = r.tour_id and t.tenant_id = p_tenant_id
  where v.asset_id = p_asset_id;
$$;

revoke all on function private.media_asset_uses(uuid, uuid) from public;

-- ── The panel: where each panorama or model is used ────────────────────────

create function public.media_asset_uses(p_tenant_id uuid, p_purpose public.asset_purpose)
returns table (
  asset_id      uuid,
  tour_id       uuid,
  content_id    uuid,
  content_kind  public.content_kind,
  content_title text,
  scope         text,
  -- The revision the tour is edited from (its draft, else its published version).
  working       boolean,
  version       integer
)
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
  if p_purpose not in ('panorama', 'model') then
    raise exception 'only panoramas and models are used by tours' using errcode = '23514';
  end if;
  return query
  select distinct a.id, u.tour_id, i.id, i.kind,
         coalesce(pr.title, dr.title, i.slug),
         u.scope, u.revision_id = coalesce(t.draft_revision_id, t.published_revision_id), u.version
  from public.assets a
  cross join lateral private.media_asset_uses(p_tenant_id, a.id) u
  join public.tours t on t.id = u.tour_id
  join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
  left join public.content_revisions pr on pr.id = i.published_revision_id
  left join public.content_revisions dr on dr.id = i.draft_revision_id
  where a.tenant_id = p_tenant_id and a.purpose = p_purpose and a.deleted_at is null;
end;
$$;

revoke all on function public.media_asset_uses(uuid, public.asset_purpose) from public, anon, authenticated;
grant execute on function public.media_asset_uses(uuid, public.asset_purpose) to authenticated;

-- ── Replacing ───────────────────────────────────────────────────────────────

-- A new version of a panorama or model (owners, admins, editors), uploaded like the first:
-- the browser PUTs the original to the signed URL and submit_panorama / submit_model starts
-- the pipeline. One replacement at a time per asset.
create function public.create_media_replacement_upload(
  p_tenant_id uuid,
  p_asset_id uuid,
  p_mime text,
  p_bytes integer
)
returns table (asset_id uuid, version_id uuid, version integer, original_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_asset public.assets%rowtype;
  v_version public.asset_versions%rowtype;
  v_mime_ok boolean;
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[])
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to upload media for this tenant' using errcode = '42501';
  end if;

  select a.* into v_asset from public.assets a
  where a.tenant_id = p_tenant_id and a.id = p_asset_id
  for update;
  if not found or v_asset.deleted_at is not null or v_asset.purpose not in ('panorama', 'model') then
    raise exception 'panorama or model not found' using errcode = 'PT404';
  end if;

  v_mime_ok := case
    when v_asset.purpose = 'model' then p_mime = 'model/gltf-binary'
    else p_mime in ('image/png', 'image/jpeg', 'image/webp')
  end;
  if p_bytes is null or p_bytes < 1 or p_bytes > 52428800 or not coalesce(v_mime_ok, false) then
    raise exception 'declared type or size out of range' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.asset_versions v
    where v.asset_id = p_asset_id
      and (v.status = 'processing'
           or (v.status = 'uploading' and v.created_at > now() - interval '1 hour'))
  ) then
    raise exception 'a replacement is already on its way' using errcode = 'PT409', hint = 'busy';
  end if;

  if (
    select count(*) from public.asset_versions v
    where v.tenant_id = p_tenant_id and v.status = 'uploading' and v.created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'too many pending uploads' using errcode = 'PT429';
  end if;

  insert into public.asset_versions (tenant_id, asset_id, version, declared_mime, declared_bytes, created_by)
  values (
    p_tenant_id, p_asset_id,
    (select max(v.version) + 1 from public.asset_versions v where v.asset_id = p_asset_id),
    p_mime, p_bytes, (select auth.uid())
  )
  returning * into v_version;

  return query select p_asset_id, v_version.id, v_version.version, v_version.original_path;
end;
$$;

revoke all on function public.create_media_replacement_upload(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.create_media_replacement_upload(uuid, uuid, text, integer) to authenticated;

-- Puts the newest ready version of a panorama or model in the draft of every tour whose
-- working revision (its draft, else its published version) uses an older one. Opens the
-- draft when there is none. Nothing reaches visitors until each tour is published.
create function public.apply_media_replacement(p_tenant_id uuid, p_version_id uuid)
returns table (tour_id uuid, opened_draft boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_version public.asset_versions%rowtype;
  v_purpose public.asset_purpose;
  v_tour public.tours%rowtype;
  v_draft public.tour_revisions%rowtype;
  v_opened boolean;
  v_tours jsonb := '[]'::jsonb;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select v.* into v_version from public.asset_versions v
  where v.tenant_id = p_tenant_id and v.id = p_version_id;
  select a.purpose into v_purpose from public.assets a
  where a.tenant_id = p_tenant_id and a.id = v_version.asset_id and a.deleted_at is null;
  if v_version.id is null or v_purpose is null or v_purpose not in ('panorama', 'model') then
    raise exception 'panorama or model not found' using errcode = 'PT404';
  end if;
  if v_version.status <> 'ready' then
    raise exception 'the new version is not ready' using errcode = 'PT409', hint = 'not_ready';
  end if;
  if exists (
    select 1 from public.asset_versions v
    where v.asset_id = v_version.asset_id and v.status = 'ready' and v.version > v_version.version
  ) then
    raise exception 'a newer version exists' using errcode = 'PT409', hint = 'stale';
  end if;

  for v_tour in
    select t.* from public.tours t
    where t.tenant_id = p_tenant_id
      and exists (
        select 1 from private.media_asset_uses(p_tenant_id, v_version.asset_id) u
        where u.tour_id = t.id and u.version_id <> v_version.id
          and u.revision_id = coalesce(t.draft_revision_id, t.published_revision_id)
      )
    order by t.created_at
  loop
    v_opened := v_tour.draft_revision_id is null;
    v_draft := private.tour_draft_for_edit(
      p_tenant_id, v_tour.id,
      (select r.edit_count from public.tour_revisions r where r.id = v_tour.draft_revision_id)
    );
    if v_purpose = 'panorama' then
      -- A tour that already has the new version in another scene keeps that scene as it is.
      update public.tour_scenes s
      set panorama_version_id = v_version.id
      where s.tour_revision_id = v_draft.id
        and s.panorama_version_id in (
          select v.id from public.asset_versions v
          where v.asset_id = v_version.asset_id and v.id <> v_version.id
        )
        and not exists (
          select 1 from public.tour_scenes o
          where o.tour_revision_id = v_draft.id and o.panorama_version_id = v_version.id
        );
    else
      update public.tour_hotspots h
      set model_version_id = v_version.id
      where h.tour_revision_id = v_draft.id
        and h.model_version_id in (
          select v.id from public.asset_versions v
          where v.asset_id = v_version.asset_id and v.id <> v_version.id
        );
    end if;
    v_tours := v_tours || to_jsonb(v_tour.id);
    tour_id := v_tour.id;
    opened_draft := v_opened;
    return next;
  end loop;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'media.replacement_applied', 'asset_version',
          v_version.id, 'success',
          jsonb_build_object('assetId', v_version.asset_id, 'version', v_version.version, 'tours', v_tours));
end;
$$;

revoke all on function public.apply_media_replacement(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_media_replacement(uuid, uuid) to authenticated;

-- ── Deleting ────────────────────────────────────────────────────────────────

-- Owners and admins delete a panorama or model no tour has ever used. Every version is
-- rejected at once (its quota is freed, nothing can start using it) and the runner removes
-- the files of each one.
create function public.delete_media_asset(p_tenant_id uuid, p_asset_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.assets%rowtype;
  v_version public.asset_versions%rowtype;
  v_bytes bigint := 0;
  v_versions integer := 0;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select a.* into v_asset from public.assets a
  where a.tenant_id = p_tenant_id and a.id = p_asset_id
  for update;
  if not found or v_asset.deleted_at is not null or v_asset.purpose not in ('panorama', 'model') then
    raise exception 'panorama or model not found' using errcode = 'PT404';
  end if;
  if exists (select 1 from private.media_asset_uses(p_tenant_id, p_asset_id)) then
    raise exception 'a tour uses it' using errcode = 'PT409', hint = 'in_use';
  end if;
  if exists (
    select 1 from public.asset_versions v where v.asset_id = p_asset_id and v.status = 'processing'
  ) then
    raise exception 'it is being processed' using errcode = 'PT409', hint = 'busy';
  end if;

  update public.assets a
  set deleted_at = now(), deleted_by = (select auth.uid())
  where a.id = p_asset_id;

  for v_version in
    select v.* from public.asset_versions v where v.asset_id = p_asset_id order by v.version for update
  loop
    if v_version.status <> 'rejected' then
      v_bytes := v_bytes + coalesce(private.measure_version_bytes(v_version.id), 0);
      -- (A manifest and public copies only belong to a ready version.)
      update public.asset_versions v
      set status = 'rejected', rejected_reason = private.deleted_media_reason(), manifest = null,
          published_at = null
      where v.id = v_version.id;
    end if;
    -- Also a rejected version may have left files (an original, tiles of a checkpoint).
    perform private.enqueue_job(
      p_tenant_id, 'media.remove_unused', 'deleted_version:' || v_version.id::text,
      jsonb_build_object('versionId', v_version.id), 'asset_version', v_version.id
    );
    v_versions := v_versions + 1;
  end loop;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'media.deleted', 'asset', p_asset_id, 'success',
          jsonb_build_object('purpose', v_asset.purpose, 'versions', v_versions, 'bytes', v_bytes));
  return v_versions;
end;
$$;

revoke all on function public.delete_media_asset(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_media_asset(uuid, uuid) to authenticated;

-- worker_api: the cleanup job also removes the files of a deleted panorama or model (the
-- version was rejected by delete_media_asset, in the same transaction that enqueued it).
create or replace function worker_api.claim_unused_media(p_job_id uuid, p_fencing_token bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
  v_bytes bigint;
  v_prefix text;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'media.remove_unused' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  v_version := private.job_asset_version(v_job);
  if v_version.id is null then
    return null;
  end if;
  select * into v_version from public.asset_versions v where v.id = v_version.id for update;
  v_prefix := v_version.tenant_id::text || '/' || v_version.asset_id::text || '/' || v_version.version::text || '/';

  if v_version.status = 'rejected' and exists (
    select 1 from public.assets a where a.id = v_version.asset_id and a.deleted_at is not null
  ) then
    return v_prefix;
  end if;
  if v_version.status = 'rejected' and v_version.rejected_reason = private.unused_media_reason() then
    return v_prefix;
  end if;
  if not private.is_unused_media(v_version.id) then
    return null;
  end if;

  v_bytes := private.measure_version_bytes(v_version.id);
  update public.asset_versions v
  set status = 'rejected', rejected_reason = private.unused_media_reason()
  where v.id = v_version.id;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', v_job.tenant_id, null, 'media.unused_removed', 'asset_version', v_version.id,
    v_job.id, 'success',
    jsonb_build_object('assetId', v_version.asset_id, 'version', v_version.version, 'bytes', v_bytes)
  );
  return v_prefix;
end;
$$;

-- ── The lists leave deleted ones out (same columns as before) ──────────────

create or replace function public.list_tenant_panoramas(p_tenant_id uuid)
returns table (
  version_id          uuid,
  asset_id            uuid,
  version             integer,
  status              public.asset_version_status,
  declared_bytes      integer,
  width               integer,
  height              integer,
  rejected_reason     text,
  manifest            jsonb,
  created_at          timestamptz,
  ready_at            timestamptz,
  job_status          public.job_status,
  job_attempts        integer,
  job_max_attempts    integer,
  job_last_error_code text
)
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
  return query
  select
    v.id, v.asset_id, v.version, v.status, v.declared_bytes, v.width, v.height,
    v.rejected_reason, v.manifest, v.created_at, v.ready_at,
    j.status, j.attempts, j.max_attempts, j.last_error_code
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
  left join public.background_jobs j
    on j.tenant_id = v.tenant_id and j.kind = 'media.process_panorama'
   and j.logical_key = 'asset_version:' || v.id::text
  where v.tenant_id = p_tenant_id and a.purpose = 'panorama' and a.deleted_at is null
    -- An upload that never finished is shown only for a while (the daily sweep cleans it).
    and (v.status <> 'uploading' or v.created_at > now() - interval '1 hour')
  order by v.created_at desc
  limit 200;
end;
$$;

create or replace function public.list_tenant_models(p_tenant_id uuid)
returns table (
  version_id          uuid,
  asset_id            uuid,
  version             integer,
  status              public.asset_version_status,
  declared_bytes      integer,
  rejected_reason     text,
  manifest            jsonb,
  created_at          timestamptz,
  ready_at            timestamptz,
  job_status          public.job_status,
  job_attempts        integer,
  job_max_attempts    integer,
  job_last_error_code text
)
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
  return query
  select
    v.id, v.asset_id, v.version, v.status, v.declared_bytes, v.rejected_reason, v.manifest,
    v.created_at, v.ready_at, j.status, j.attempts, j.max_attempts, j.last_error_code
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
  left join public.background_jobs j
    on j.tenant_id = v.tenant_id and j.kind = 'media.process_model'
   and j.logical_key = 'asset_version:' || v.id::text
  where v.tenant_id = p_tenant_id and a.purpose = 'model' and a.deleted_at is null
    -- An upload that never finished is shown only for a while (the daily sweep cleans it).
    and (v.status <> 'uploading' or v.created_at > now() - interval '1 hour')
  order by v.created_at desc
  limit 200;
end;
$$;
