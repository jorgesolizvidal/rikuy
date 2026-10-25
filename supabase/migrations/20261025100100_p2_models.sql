-- ─────────────────────────────────────────────────────────────────────────────
-- P2 · Paso 4: GLB pipeline (ADR-026).
--
--   * A 3D model is a version of purpose 'model': the browser uploads the GLB (up to 50 MB)
--     straight to the private bucket, then submit_model moves it to 'processing' and
--     enqueues media.process_model in the same transaction (the runner is woken, ADR-025).
--   * Under the job's lease the runner validates the file, optimizes it (Meshopt geometry,
--     KTX2 textures encoded per use and checked by decoding them) and writes
--     {tenant}/{asset}/{version}/model/model.glb in the PRIVATE bucket until a tour publishes
--     it (P4). The original never changes. Over 15 MB optimized → rejected; 5–15 MB → ready,
--     marked heavy.
--   * The poster image is captured by the panel with the same viewer as the portal (no GPU
--     on the server) and attached with set_model_poster.
--   * The version keeps a versioned manifest (what was produced, the color check, the
--     poster). Hotspots will reference the version, never a file.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Storage and versions ────────────────────────────────────────────────────

-- The private bucket also holds GLB originals, the optimized GLB and the KTX2 textures the
-- pipeline keeps between attempts.
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'model/gltf-binary', 'image/ktx2']
where id = 'media-originals';

alter table public.asset_versions drop constraint asset_versions_declared_mime;
alter table public.asset_versions
  add constraint asset_versions_declared_mime check (
    declared_mime in ('image/png', 'image/jpeg', 'image/webp', 'model/gltf-binary')
  );

-- A ready model has no pixel size; everything else keeps the same requirements.
alter table public.asset_versions drop constraint asset_versions_ready_has_metadata;
alter table public.asset_versions
  add constraint asset_versions_ready_has_metadata check (
    status <> 'ready' or (
      bytes > 0 and sha256 ~ '^[0-9a-f]{64}$' and ready_at is not null
      and (
        (mime in ('image/png', 'image/jpeg', 'image/webp') and width > 0 and height > 0)
        or (mime = 'model/gltf-binary' and width is null and height is null)
      )
    )
  );

-- Uploads: images keep their types; a model is only a GLB (up to 50 MB).
create or replace function public.create_image_upload(
  p_tenant_id uuid,
  p_purpose public.asset_purpose,
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
  v_asset uuid;
  v_version public.asset_versions%rowtype;
  -- (A CASE inside an IF condition confuses the PL/pgSQL parser: computed here.)
  v_max_bytes integer := case when p_purpose in ('panorama', 'model') then 52428800 else 10485760 end;
  v_mime_ok boolean := case
    when p_purpose = 'model' then p_mime = 'model/gltf-binary'
    else p_mime in ('image/png', 'image/jpeg', 'image/webp')
  end;
begin
  if not private.has_tenant_role(
       p_tenant_id,
       case when p_purpose = 'logo'
         then array['owner', 'admin']::public.membership_role[]
         else array['owner', 'admin', 'editor']::public.membership_role[]
       end)
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to upload media for this tenant' using errcode = '42501';
  end if;

  if p_bytes is null or p_bytes < 1 or p_bytes > v_max_bytes or not coalesce(v_mime_ok, false) then
    raise exception 'declared type or size out of range' using errcode = '23514';
  end if;

  if (
    select count(*) from public.asset_versions v
    where v.tenant_id = p_tenant_id and v.status = 'uploading' and v.created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'too many pending uploads' using errcode = 'PT429';
  end if;

  insert into public.assets (tenant_id, purpose, created_by)
  values (p_tenant_id, p_purpose, (select auth.uid()))
  returning id into v_asset;

  insert into public.asset_versions (tenant_id, asset_id, version, declared_mime, declared_bytes, created_by)
  values (p_tenant_id, v_asset, 1, p_mime, p_bytes, (select auth.uid()))
  returning * into v_version;

  return query select v_asset, v_version.id, v_version.version, v_version.original_path;
end;
$$;

-- The synchronous image path (logos and photos) never completes another kind of media.
create or replace function public.media_complete_upload(
  p_version_id uuid,
  p_mime text,
  p_bytes integer,
  p_width integer,
  p_height integer,
  p_sha256 text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.asset_versions v
  set status = 'ready', mime = p_mime, bytes = p_bytes, width = p_width, height = p_height,
      sha256 = p_sha256, ready_at = now()
  from public.assets a
  where v.id = p_version_id and v.status = 'uploading'
    and a.tenant_id = v.tenant_id and a.id = v.asset_id and a.purpose in ('logo', 'content');
  if not found then
    raise exception 'version is not an uploading image' using errcode = 'PT409';
  end if;
end;
$$;

-- ── The job ─────────────────────────────────────────────────────────────────

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values ('media.process_model', 'media', 4, 120, 240, 1, 'Optimización de un modelo 3D (GLB)');

create or replace function private.is_valid_job_payload(p_kind text, p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    -- {"mode": "ok" | "fail_once" | "fail_always", "workMs": 0..10000}, both optional.
    when p_kind = 'system.probe' then
      jsonb_typeof(p_payload) = 'object'
      and not exists (
        select 1 from jsonb_object_keys(p_payload) k where k not in ('mode', 'workMs')
      )
      and (not p_payload ? 'mode' or p_payload ->> 'mode' in ('ok', 'fail_once', 'fail_always'))
      and (
        not p_payload ? 'workMs'
        or (
          jsonb_typeof(p_payload -> 'workMs') = 'number'
          and (p_payload ->> 'workMs') ~ '^[0-9]{1,5}$'
          and (p_payload ->> 'workMs')::integer between 0 and 10000
        )
      )
    -- {"versionId": uuid}; the job's subject is the same version.
    when p_kind in ('media.expire_abandoned_upload', 'media.process_panorama', 'media.process_model') then
      jsonb_typeof(p_payload) = 'object'
      and not exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'versionId')
      and coalesce(p_payload ->> 'versionId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    else false
  end;
$$;

-- The poster the panel captured (contract: @rikuy/core modelPosterSchema).
create function private.is_valid_model_poster(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'object'
    and not exists (
      select 1 from jsonb_object_keys(p) k where k not in ('file', 'width', 'height', 'bytes')
    )
    and p ->> 'file' = 'poster.webp'
    and (p ->> 'width') ~ '^[0-9]{2,4}$' and (p ->> 'width')::integer between 64 and 2048
    and (p ->> 'height') ~ '^[0-9]{2,4}$' and (p ->> 'height')::integer between 64 and 2048
    and (p ->> 'bytes') ~ '^[0-9]{1,7}$' and (p ->> 'bytes')::integer between 1 and 1048576,
    false
  );
$$;

-- What a finished pipeline must describe (contract: @rikuy/core modelManifestSchema).
create function private.is_valid_model_manifest(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'object'
    and p ->> 'version' = '1'
    and p ->> 'format' = 'glb'
    and jsonb_typeof(p -> 'source') = 'object'
    and jsonb_typeof(p -> 'model') = 'object'
    and p -> 'model' ->> 'file' = 'model.glb'
    and (p -> 'model' ->> 'bytes') ~ '^[0-9]{1,8}$'
    and (p -> 'model' ->> 'bytes')::integer between 1 and 15728640
    and p -> 'model' ->> 'geometry' = 'meshopt'
    and jsonb_typeof(p -> 'model' -> 'textures') = 'array'
    and jsonb_array_length(p -> 'model' -> 'textures') <= 64
    and jsonb_typeof(p -> 'colors') = 'object'
    and p -> 'colors' ->> 'materials' = 'unchanged'
    and jsonb_typeof(p -> 'colors' -> 'suspects') = 'array'
    and p ->> 'weight' in ('light', 'heavy')
    and (jsonb_typeof(p -> 'poster') = 'null' or private.is_valid_model_poster(p -> 'poster'))
    and position('..' in p::text) = 0,
    false
  );
$$;

revoke all on function private.is_valid_model_poster(jsonb) from public;
revoke all on function private.is_valid_model_manifest(jsonb) from public;

-- ── People: submit an uploaded model, see the municipality's models, set a poster ──
-- Error codes: 42501 forbidden · PT404 unknown · PT409 hint 'not_uploaded' / 'not_ready' ·
-- 23514 invalid poster.

create function public.submit_model(p_tenant_id uuid, p_version_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.asset_versions;
  v_job uuid;
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[])
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to submit models for this tenant' using errcode = '42501';
  end if;

  select v.* into v_version
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
  where v.id = p_version_id and v.tenant_id = p_tenant_id and a.purpose = 'model'
  for update of v;
  if not found then
    raise exception 'model not found' using errcode = 'PT404';
  end if;
  -- Idempotent: submitting twice is harmless.
  if v_version.status <> 'uploading' then
    return v_version.status::text;
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'media-originals' and o.name = v_version.original_path
  ) then
    raise exception 'the original was not uploaded' using errcode = 'PT409', hint = 'not_uploaded';
  end if;

  update public.asset_versions v set status = 'processing' where v.id = v_version.id;

  select e.job_id into v_job
  from private.enqueue_job(
    p_tenant_id, 'media.process_model', 'asset_version:' || v_version.id::text,
    jsonb_build_object('versionId', v_version.id), 'asset_version', v_version.id
  ) e;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', p_tenant_id, (select auth.uid()), 'media.model_submitted', 'asset_version',
    v_version.id, v_job, 'success', jsonb_build_object('bytes', v_version.declared_bytes)
  );
  return 'processing';
end;
$$;

create function public.list_tenant_models(p_tenant_id uuid)
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
  where v.tenant_id = p_tenant_id and a.purpose = 'model'
    -- An upload that never finished is shown only for a while (the daily sweep cleans it).
    and (v.status <> 'uploading' or v.created_at > now() - interval '1 hour')
  order by v.created_at desc
  limit 200;
end;
$$;

-- The panel captured the poster and the server stored it next to the model; this records it.
create function public.set_model_poster(p_tenant_id uuid, p_version_id uuid, p_poster jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.asset_versions;
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[])
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to change models of this tenant' using errcode = '42501';
  end if;
  if not private.is_valid_model_poster(p_poster) then
    raise exception 'invalid poster' using errcode = '23514';
  end if;

  select v.* into v_version
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
  where v.id = p_version_id and v.tenant_id = p_tenant_id and a.purpose = 'model'
  for update of v;
  if not found then
    raise exception 'model not found' using errcode = 'PT404';
  end if;
  if v_version.status <> 'ready' then
    raise exception 'the model is not ready' using errcode = 'PT409', hint = 'not_ready';
  end if;

  update public.asset_versions v
  set manifest = jsonb_set(v.manifest, '{poster}', p_poster)
  where v.id = v_version.id;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff
  )
  values (
    'tenant', p_tenant_id, (select auth.uid()), 'media.model_poster_set', 'asset_version',
    v_version.id, 'success',
    jsonb_build_object('width', p_poster -> 'width', 'height', p_poster -> 'height')
  );
end;
$$;

revoke all on function public.submit_model(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_tenant_models(uuid) from public, anon, authenticated;
revoke all on function public.set_model_poster(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.submit_model(uuid, uuid) to authenticated;
grant execute on function public.list_tenant_models(uuid) to authenticated;
grant execute on function public.set_model_poster(uuid, uuid, jsonb) to authenticated;

-- ── worker_api: the pipeline, always under the job's lease ─────────────────

-- The version the job is about (of the job's own tenant), checked to be a model.
create function private.job_model_version(p_job public.background_jobs)
returns public.asset_versions
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_version public.asset_versions;
begin
  if p_job.kind <> 'media.process_model' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  v_version := private.job_asset_version(p_job);
  if v_version.id is null or not exists (
    select 1 from public.assets a
    where a.tenant_id = v_version.tenant_id and a.id = v_version.asset_id and a.purpose = 'model'
  ) then
    return null;
  end if;
  return v_version;
end;
$$;

revoke all on function private.job_model_version(public.background_jobs) from public;

create function worker_api.model_source(p_job_id uuid, p_fencing_token bigint)
returns table (status text, original_path text, declared_mime text, prefix text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.asset_versions;
begin
  v_version := private.job_model_version(private.leased_job(p_job_id, p_fencing_token));
  if v_version.id is null then
    return query select 'not_found'::text, null::text, null::text, null::text;
    return;
  end if;
  return query select
    v_version.status::text, v_version.original_path, v_version.declared_mime,
    v_version.tenant_id::text || '/' || v_version.asset_id::text || '/' || v_version.version::text || '/';
end;
$$;

-- p_bytes and p_sha256 describe the ORIGINAL (what was uploaded); the manifest, what was made.
create function worker_api.complete_model(
  p_job_id uuid,
  p_fencing_token bigint,
  p_bytes integer,
  p_sha256 text,
  p_manifest jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  v_version := private.job_model_version(v_job);
  if v_version.id is null then
    return 'not_found';
  end if;
  if not private.is_valid_model_manifest(p_manifest) or p_manifest -> 'poster' <> 'null'::jsonb then
    raise exception 'invalid model manifest' using errcode = '23514';
  end if;

  update public.asset_versions v
  set status = 'ready', mime = 'model/gltf-binary', bytes = p_bytes, width = null, height = null,
      sha256 = p_sha256, manifest = p_manifest, ready_at = now()
  where v.id = v_version.id and v.status = 'processing';
  if not found then
    return 'already_settled';
  end if;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', v_job.tenant_id, null, 'media.model_ready', 'asset_version', v_version.id,
    v_job.id, 'success',
    jsonb_build_object(
      'bytes', p_manifest -> 'model' -> 'bytes',
      'weight', p_manifest -> 'weight',
      'suspects', jsonb_array_length(p_manifest -> 'colors' -> 'suspects')
    )
  );
  return 'ready';
end;
$$;

create function worker_api.reject_model(p_job_id uuid, p_fencing_token bigint, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  v_version := private.job_model_version(v_job);
  if v_version.id is null then
    return 'not_found';
  end if;
  if v_reason is null then
    raise exception 'a reason is required' using errcode = '23514';
  end if;

  update public.asset_versions v
  set status = 'rejected', rejected_reason = v_reason
  where v.id = v_version.id and v.status = 'processing';
  if not found then
    return 'already_settled';
  end if;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', v_job.tenant_id, null, 'media.model_rejected', 'asset_version', v_version.id,
    v_job.id, 'success', jsonb_build_object('reason', v_reason)
  );
  return 'rejected';
end;
$$;

revoke all on function worker_api.model_source(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function worker_api.complete_model(uuid, bigint, integer, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function worker_api.reject_model(uuid, bigint, text) from public, anon, authenticated, service_role;
grant execute on function worker_api.model_source(uuid, bigint) to rikuy_worker;
grant execute on function worker_api.complete_model(uuid, bigint, integer, text, jsonb) to rikuy_worker;
grant execute on function worker_api.reject_model(uuid, bigint, text) to rikuy_worker;
